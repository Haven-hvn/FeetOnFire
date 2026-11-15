// The game's audio: one AudioContext, the mixer worklet, and the clock that says which music
// time is being heard at a given moment.
//
// Music time. The music is converted once to the context's sample rate, keeping time (music
// time t is frame t * sampleRate, as frame 0 of the decoded file is music time 0). Playing
// tells the worklet "music frame `offsetFrames` goes out at context frame `startFrame`", and
// from then on
//
//   music seconds heard at performance time p
//       = (offsetFrames - startFrame) / sampleRate + (context time heard at p)
//
// The last term comes from AudioContext.getOutputTimestamp() through AudioClockMap, which
// includes the output latency the browser knows about. Latency it does not know about is the
// calibration offset's job (docs/LATENCY.md).

import { AudioClockMap, predictionErrors } from '../shared/clock.ts';
import { linearFit, round } from '../shared/stats.ts';
import { Mixer } from './mixer.ts';
import type { DecodedAudio } from './pcm.ts';
import { resample, resampledLength } from './resample.ts';
import type { ResampleReply, ResampleRequest } from './resample-worker.ts';

const SAMPLE_INTERVAL_MS = 50;
/** Pairs kept for the clock report: five minutes. */
const HISTORY = 6000;
/** A pair this far from the map's prediction means the clock jumped (device change, long stall). */
const JUMP_MS = 50;

export interface MusicInfo {
  /** Frames at the context's sample rate. */
  frames: number;
  seconds: number;
  /** The file's own sample rate. */
  sourceRate: number;
  resampled: boolean;
}

export interface PlayInfo {
  /** Context frame at which playback starts. */
  startFrame: number;
  /** Music frame that goes out at `startFrame`. Negative: silence first. */
  offsetFrames: number;
  /** `offsetFrames` in seconds: the music time at `startFrame`, after rounding to a frame. */
  fromSeconds: number;
}

export interface ClockReport {
  pairs: number;
  /** Audio device clock against the system clock, parts per million. */
  driftPpm: number | null;
  /** Error of the map predicting each new pair from the ones before it: what the game sees. */
  predictionRmsMs: number | null;
  predictionMaxMs: number | null;
  /** Times the map was started afresh because the clock jumped or the context was suspended. */
  resets: number;
  /** Steps of the heard position (device reconfigured or stalled) the map followed. */
  steps: number;
  lastStepMs: number;
}

function canShare(): boolean {
  return typeof SharedArrayBuffer !== 'undefined' && globalThis.crossOriginIsolated === true;
}

/**
 * Converts channels from `from` Hz to `to` Hz, keeping time (resample.ts). Runs in a worker; on
 * this thread when a worker cannot be started. The result is always new arrays, in shared
 * memory when `shared` is set.
 */
export async function convertRate(channels: Float32Array[], from: number, to: number, shared: boolean): Promise<Float32Array[]> {
  const inline = (): Float32Array[] =>
    channels.map((channel) => {
      const length = resampledLength(channel.length, from, to);
      return resample(channel, from, to, shared ? new Float32Array(new SharedArrayBuffer(length * 4)) : new Float32Array(length));
    });
  if (from === to) return inline(); // a copy
  let worker: Worker;
  try {
    worker = new Worker(new URL('./resample-worker.js', import.meta.url), { type: 'module' });
  } catch {
    return inline();
  }
  try {
    return await new Promise<Float32Array[]>((resolve, reject) => {
      worker.onmessage = (e: MessageEvent) => {
        const reply = e.data as ResampleReply;
        if (reply.channels) resolve(reply.channels);
        else reject(new Error(reply.error ?? 'Sample rate conversion failed'));
      };
      worker.onerror = (e) => reject(new Error(e.message || 'The sample rate conversion worker failed to start'));
      const request: ResampleRequest = { id: 1, channels, from, to, shared };
      worker.postMessage(request);
    });
  } finally {
    worker.terminate();
  }
}

export class AudioEngine {
  readonly context: AudioContext;
  readonly mixer: Mixer;
  readonly clock = new AudioClockMap();

  private music: MusicInfo | null = null;
  private playing: PlayInfo | null = null;
  private timer = 0;
  private lastPerf = -1;
  private resets = 0;
  // The last HISTORY pairs, as a ring.
  private readonly perf = new Float64Array(HISTORY);
  private readonly ctx = new Float64Array(HISTORY);
  private pairs = 0;
  /** Called when the music runs out, with the performance time at which its end is heard. */
  onMusicEnded: ((perfMs: number) => void) | null = null;
  /** Called after the clock map has taken a new pair, or has been started afresh. */
  onClockChanged: (() => void) | null = null;

  private constructor(context: AudioContext, mixer: Mixer) {
    this.context = context;
    this.mixer = mixer;
    mixer.onEnded = (frame) => this.onMusicEnded?.(this.clock.perfTimeAt(frame / context.sampleRate));
    context.addEventListener('statechange', () => this.restartClock());
    this.timer = window.setInterval(this.sample, SAMPLE_INTERVAL_MS);
  }

  /**
   * Creates the context and the mixer. Browsers only let audio start after the user has done
   * something on the page: call this (or resume()) from a click or key handler.
   */
  static async create(options: { latencyHint?: AudioContextLatencyCategory | number } = {}): Promise<AudioEngine> {
    const context = new AudioContext({ latencyHint: options.latencyHint ?? 'interactive' });
    try {
      const mixer = await Mixer.create(context);
      const engine = new AudioEngine(context, mixer);
      await context.resume();
      return engine;
    } catch (error) {
      await context.close();
      throw error;
    }
  }

  get sampleRate(): number {
    return this.context.sampleRate;
  }

  get musicInfo(): MusicInfo | null {
    return this.music;
  }

  get playInfo(): PlayInfo | null {
    return this.playing;
  }

  async resume(): Promise<void> {
    await this.context.resume();
  }

  async close(): Promise<void> {
    window.clearInterval(this.timer);
    this.playing = null;
    await this.context.close();
  }

  private restartClock(): void {
    if (this.clock.samples > 0) this.resets++;
    this.clock.reset();
    this.pairs = 0;
    this.lastPerf = -1;
    this.onClockChanged?.();
  }

  private sample = (): void => {
    const context = this.context;
    if (context.state !== 'running') return;
    const stamp = context.getOutputTimestamp();
    const perf = stamp.performanceTime ?? 0;
    const time = stamp.contextTime ?? 0;
    if (!(perf > 0 && time > 0) || perf === this.lastPerf) return;
    if (this.clock.samples > 0 && Math.abs(time - this.clock.contextTimeAt(perf)) * 1000 > JUMP_MS) this.restartClock();
    this.lastPerf = perf;
    this.clock.add(perf, time);
    this.perf[this.pairs % HISTORY] = perf;
    this.ctx[this.pairs % HISTORY] = time;
    this.pairs++;
    this.onClockChanged?.();
  };

  /** Context time (seconds) of the audio being heard at performance time `perfMs`. */
  heardContextTimeAt(perfMs: number): number {
    if (this.clock.samples > 0) return this.clock.contextTimeAt(perfMs);
    // Nothing measured yet: the browser's own latency figure.
    return this.context.currentTime - this.context.outputLatency + (perfMs - performance.now()) / 1000;
  }

  /**
   * Takes decoded audio as the music: converts it to the context's sample rate and gives it to
   * the worklet. Stops what is playing. The decoded audio itself is left as it is.
   */
  async loadMusic(audio: DecodedAudio): Promise<MusicInfo> {
    this.stopMusic(0);
    const rate = this.context.sampleRate;
    const channels = await convertRate(audio.channels.slice(0, 2), audio.sampleRate, rate, canShare());
    this.mixer.setMusic(channels);
    const frames = channels[0]?.length ?? 0;
    this.music = { frames, seconds: frames / rate, sourceRate: audio.sampleRate, resampled: audio.sampleRate !== rate };
    return this.music;
  }

  /**
   * Starts the music `delaySeconds` from now at music time `fromSeconds`. A negative
   * `fromSeconds` gives a silent lead-in: music time runs from there and the first sample
   * comes out when it reaches 0.
   */
  playMusic(options: { fromSeconds?: number; delaySeconds?: number; gain?: number } = {}): PlayInfo {
    if (!this.music) throw new Error('No music is loaded');
    const rate = this.context.sampleRate;
    const startFrame = Math.ceil(this.context.currentTime * rate) + Math.round((options.delaySeconds ?? 0.05) * rate);
    const offsetFrames = Math.round((options.fromSeconds ?? 0) * rate);
    this.mixer.play(startFrame, offsetFrames, options.gain ?? 1);
    this.playing = { startFrame, offsetFrames, fromSeconds: offsetFrames / rate };
    return this.playing;
  }

  stopMusic(fadeSeconds = 0.02): void {
    this.mixer.stop(Math.round(fadeSeconds * this.context.sampleRate));
    this.playing = null;
  }

  setMusicGain(gain: number): void {
    this.mixer.setGain(gain);
  }

  /**
   * Music time (seconds) being heard at performance time `perfMs`; null when no music is
   * playing. Keeps counting past the end of the music.
   */
  musicSecondsAt(perfMs: number = performance.now()): number | null {
    const playing = this.playing;
    if (!playing) return null;
    return (playing.offsetFrames - playing.startFrame) / this.context.sampleRate + this.heardContextTimeAt(perfMs);
  }

  /**
   * Music seconds minus heard context seconds while music plays, else null:
   * musicSecondsAt(p) = musicOffsetSeconds + heardContextTimeAt(p).
   */
  get musicOffsetSeconds(): number | null {
    const playing = this.playing;
    return playing ? (playing.offsetFrames - playing.startFrame) / this.context.sampleRate : null;
  }

  /** Performance time (ms) at which music time `seconds` is heard; null when no music is playing. */
  perfTimeOfMusic(seconds: number): number | null {
    const playing = this.playing;
    if (!playing || this.clock.samples === 0) return null;
    return this.clock.perfTimeAt(seconds + (playing.startFrame - playing.offsetFrames) / this.context.sampleRate);
  }

  /** Stores an effect sound under `id` (0..63), converted to the context's sample rate. */
  async loadSound(id: number, audio: DecodedAudio): Promise<void> {
    const channels = await convertRate(audio.channels.slice(0, 2), audio.sampleRate, this.context.sampleRate, false);
    this.mixer.setSound(id, channels);
  }

  /** Plays an effect sound: at music time `atMusicSeconds` when given and music is playing, else at once. */
  playSound(id: number, options: { atMusicSeconds?: number; gain?: number } = {}): void {
    const playing = this.playing;
    let frame = -1;
    if (options.atMusicSeconds !== undefined && playing) {
      frame = Math.max(0, playing.startFrame + Math.round(options.atMusicSeconds * this.context.sampleRate) - playing.offsetFrames);
    }
    this.mixer.trigger(id, frame, options.gain ?? 1);
  }

  /** How well the performance clock is mapped to the audio being heard (docs/LATENCY.md section 4). */
  clockReport(): ClockReport {
    const n = Math.min(this.pairs, HISTORY);
    const perf = new Float64Array(n);
    const ctx = new Float64Array(n);
    const first = this.pairs - n;
    for (let i = 0; i < n; i++) {
      perf[i] = this.perf[(first + i) % HISTORY]!;
      ctx[i] = this.ctx[(first + i) % HISTORY]!;
    }
    const fit = linearFit(
      perf,
      ctx.map((seconds) => seconds * 1000),
    );
    const errors = predictionErrors(perf, ctx).values();
    let squares = 0;
    let max = 0;
    for (const error of errors) {
      squares += error * error;
      if (Math.abs(error) > max) max = Math.abs(error);
    }
    return {
      pairs: n,
      driftPpm: fit ? round((fit.slope - 1) * 1e6, 1) : null,
      predictionRmsMs: errors.length > 0 ? round(Math.sqrt(squares / errors.length), 4) : null,
      predictionMaxMs: errors.length > 0 ? round(max, 4) : null,
      resets: this.resets,
      steps: this.clock.steps,
      lastStepMs: round(this.clock.lastStepMs, 3),
    };
  }
}
