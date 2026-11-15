// Audio section of the Latency Lab: output latency as reported by the browser, quality of
// the performance-clock <-> heard-audio map, worklet behaviour, click playback, recording.

import { AudioClockMap, predictionErrors } from '../shared/clock.ts';
import { makeClick } from '../shared/onset.ts';
import { Series, linearFit, round, roundSummary, summarize } from '../shared/stats.ts';

export interface Recording {
  samples: Float32Array;
  /** Context frame at which the first sample was delivered to the worklet. */
  startFrame: number;
}

const SAMPLE_INTERVAL_MS = 50;

export class AudioLab {
  ctx: AudioContext | null = null;
  click: Float32Array = new Float32Array(0);
  readonly map = new AudioClockMap();

  private node: AudioWorkletNode | null = null;
  private shared: Int32Array | null = null;
  private mic: MediaStream | null = null;
  private micSource: MediaStreamAudioSourceNode | null = null;
  private timer = 0;
  private hint = '';
  private lastPerf = -1;
  private pending: ((r: Recording) => void) | null = null;
  private clicksPlayed = 0;
  private keepAwake = true;
  /** The report as it was when the test was last stopped. */
  private last: Record<string, unknown> | null = null;

  private readonly sPerf = new Series();
  private readonly sCtx = new Series();
  private readonly sNow = new Series();
  private readonly sFrameMs = new Series();
  private readonly sOutLat = new Series();
  private readonly sHeardDiff = new Series();
  /** Skipped render quanta, as [performance ms when noticed, context second, gap ms, count so far]. */
  private skips: number[][] = [];
  private skipsSeen = 0;
  /** Changes of the reported output latency, as [performance ms, latency ms]. */
  private latencySteps: number[][] = [];
  /** The trace as it was when the test was last stopped. */
  private lastTrace: Record<string, unknown> | null = null;

  get running(): boolean {
    return this.ctx !== null;
  }

  get hasMic(): boolean {
    return this.mic !== null;
  }

  get sampleRate(): number {
    return this.ctx ? this.ctx.sampleRate : 0;
  }

  /**
   * `keepAwake`: never render pure silence, as the game does. Without it Chrome takes the
   * audio device away after 30 s of silence and the clock steps.
   */
  async start(latencyHint: AudioContextLatencyCategory | number, keepAwake = true): Promise<void> {
    if (this.ctx) return;
    this.keepAwake = keepAwake;
    // A new run: figures of an earlier one must not mix in (its context time began at 0 too).
    for (const series of [this.sPerf, this.sCtx, this.sNow, this.sFrameMs, this.sOutLat, this.sHeardDiff]) series.clear();
    this.map.reset();
    this.map.steps = 0;
    this.lastPerf = -1;
    this.skips = [];
    this.skipsSeen = 0;
    this.latencySteps = [];
    this.clicksPlayed = 0;
    const ctx = new AudioContext({ latencyHint });
    this.hint = String(latencyHint);
    await ctx.audioWorklet.addModule(new URL('./click-worklet.js', import.meta.url));
    this.click = makeClick(ctx.sampleRate);
    const sab = typeof SharedArrayBuffer !== 'undefined' && window.crossOriginIsolated ? new SharedArrayBuffer(32) : null;
    this.shared = sab ? new Int32Array(sab) : null;
    const node = new AudioWorkletNode(ctx, 'lab-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      processorOptions: { click: this.click, shared: sab, keepAwake },
    });
    node.port.onmessage = (e: MessageEvent) => {
      const msg = e.data as { type: string; samples: Float32Array; length: number; startFrame: number };
      if (msg.type === 'recording' && this.pending) {
        const done = this.pending;
        this.pending = null;
        done({ samples: msg.samples.subarray(0, msg.length), startFrame: msg.startFrame });
      }
    };
    node.connect(ctx.destination);
    await ctx.resume();
    this.ctx = ctx;
    this.node = node;
    this.timer = window.setInterval(this.sample, SAMPLE_INTERVAL_MS);
  }

  async stop(): Promise<void> {
    // Keep the result: the report is downloaded after the tests have been stopped.
    const snapshot = this.report();
    if (this.ctx && snapshot) {
      this.last = { ...snapshot, stopped: true };
      this.lastTrace = this.trace();
    }
    window.clearInterval(this.timer);
    this.mic?.getTracks().forEach((t) => t.stop());
    this.mic = null;
    this.micSource = null;
    const ctx = this.ctx;
    this.ctx = null;
    this.node = null;
    if (ctx) await ctx.close();
  }

  private sample = (): void => {
    const ctx = this.ctx;
    if (!ctx) return;
    const ts = ctx.getOutputTimestamp();
    const now = performance.now();
    const perf = ts.performanceTime ?? 0;
    const ctxTime = ts.contextTime ?? 0;
    if (perf > 0 && ctxTime > 0) {
      if (perf !== this.lastPerf) {
        this.lastPerf = perf;
        this.sPerf.push(perf);
        this.sCtx.push(ctxTime);
        this.map.add(perf, ctxTime);
      }
      // Two ways to estimate "context time being heard now"; their disagreement shows
      // why currentTime alone is not good enough for judging.
      const viaTimestamp = ctxTime + (now - perf) / 1000;
      const viaCurrentTime = ctx.currentTime - ctx.outputLatency;
      this.sHeardDiff.push((viaTimestamp - viaCurrentTime) * 1000);
    }
    const latency = ctx.outputLatency * 1000;
    this.sOutLat.push(latency);
    const lastStep = this.latencySteps[this.latencySteps.length - 1];
    if ((!lastStep || lastStep[1] !== round(latency)) && this.latencySteps.length < 500) this.latencySteps.push([round(now), round(latency)]);
    if (this.shared) {
      this.sNow.push(now);
      this.sFrameMs.push((Atomics.load(this.shared, 0) / ctx.sampleRate) * 1000);
      // Two skips within one sampling interval show as one entry (the latest); the count tells.
      const count = Atomics.load(this.shared, 2);
      if (count !== this.skipsSeen) {
        this.skipsSeen = count;
        if (this.skips.length < 500) this.skips.push([round(now), round(Atomics.load(this.shared, 4) / ctx.sampleRate, 4), round((Atomics.load(this.shared, 3) / ctx.sampleRate) * 1000, 3), count]);
      }
    }
  };

  /**
   * Schedule `count` clicks starting `leadMs` from now, spaced `intervalMs` plus a random
   * 0..`jitterMs` apart. Returns the context frames at which the clicks start.
   */
  scheduleClicks(count: number, intervalMs: number, leadMs = 300, jitterMs = 0): number[] {
    const ctx = this.ctx;
    if (!ctx || !this.node) throw new Error('Audio is not running');
    const sr = ctx.sampleRate;
    let frame = Math.round(ctx.currentTime * sr + (leadMs / 1000) * sr);
    const frames: number[] = [];
    for (let i = 0; i < count; i++) {
      frames.push(frame);
      frame += Math.round(((intervalMs + Math.random() * jitterMs) / 1000) * sr);
    }
    this.node.port.postMessage({ type: 'clicks', frames });
    this.clicksPlayed += count;
    return frames;
  }

  /** Performance time (ms) at which the sample rendered at `frame` is heard. */
  heardPerfTime(frame: number): number {
    return this.map.perfTimeAt(frame / this.sampleRate);
  }

  /** Context frame being heard at performance time `perfMs`. */
  heardFrameAt(perfMs: number): number {
    return this.map.contextTimeAt(perfMs) * this.sampleRate;
  }

  async attachMic(): Promise<void> {
    const ctx = this.ctx;
    if (!ctx || !this.node) throw new Error('Start audio first');
    if (this.mic) return;
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
    });
    this.mic = stream;
    this.micSource = ctx.createMediaStreamSource(stream);
    this.micSource.connect(this.node); // into the recorder only; never to the speakers
  }

  record(seconds: number): Promise<Recording> {
    if (!this.node) return Promise.reject(new Error('Audio is not running'));
    if (this.pending) return Promise.reject(new Error('A recording is already in progress'));
    return new Promise<Recording>((resolve) => {
      this.pending = resolve;
      this.node!.port.postMessage({ type: 'record', seconds });
    });
  }

  /**
   * The raw figures behind the report, for the downloaded file only: what a summary cannot
   * show is whether a large clock-map error sits next to a skipped quantum.
   */
  trace(): Record<string, unknown> | null {
    if (!this.ctx) return this.lastTrace;
    return {
      // Pairs from getOutputTimestamp(): performance ms and context seconds.
      perfMs: Array.from(this.sPerf.values(), (v) => round(v, 3)),
      contextSeconds: Array.from(this.sCtx.values(), (v) => round(v, 6)),
      // [performance ms when noticed, context second, gap ms, count so far]
      skippedQuanta: this.skips,
      // [performance ms, reported output latency ms], one entry per change
      outputLatencySteps: this.latencySteps,
    };
  }

  report(): Record<string, unknown> | null {
    const ctx = this.ctx;
    if (!ctx) return this.last;
    const perf = this.sPerf.values();
    const ctxSec = this.sCtx.values();
    const ctxMs = Float64Array.from(ctxSec, (v) => v * 1000);
    const fit = linearFit(perf, ctxMs);
    const frameFit = linearFit(this.sNow.values(), this.sFrameMs.values());
    const frameResiduals: number[] = [];
    if (frameFit) {
      const now = this.sNow.values();
      const fr = this.sFrameMs.values();
      for (let i = 0; i < now.length; i++) frameResiduals.push(fr[i] - (frameFit.intercept + frameFit.slope * now[i]));
    }
    const stats = (ctx as unknown as { playbackStats?: Record<string, unknown> }).playbackStats;
    let playback: Record<string, unknown> | null = null;
    if (stats) {
      playback = {};
      for (const key of ['underrunDuration', 'underrunEvents', 'totalDuration', 'averageLatency', 'minimumLatency', 'maximumLatency']) {
        const v = stats[key];
        if (typeof v === 'number') playback[key] = round(v, 5);
      }
    }
    return {
      latencyHint: this.hint,
      keepAwake: this.keepAwake,
      state: ctx.state,
      sampleRate: ctx.sampleRate,
      baseLatencyMs: round(ctx.baseLatency * 1000),
      outputLatencyMs: roundSummary(summarize(this.sOutLat.values())),
      reportedOutputTotalMs: round((ctx.baseLatency + ctx.outputLatency) * 1000),
      clockMap: {
        pairs: perf.length,
        // Audio device clock relative to the system clock, parts per million.
        driftPpm: fit ? round((fit.slope - 1) * 1e6, 1) : null,
        wholeRunResidualRmsMs: fit ? round(fit.rms, 4) : null,
        wholeRunResidualMaxMs: fit ? round(fit.maxAbs, 4) : null,
        // Error of a sliding-window map predicting each new pair: what the game would see.
        predictionErrorMs: roundSummary(summarize(predictionErrors(perf, ctxSec).values()), 4),
        // Steps of the heard position that the map followed (device reconfigured or stalled).
        steps: this.map.steps,
        lastStepMs: round(this.map.lastStepMs),
      },
      // (getOutputTimestamp estimate) - (currentTime - outputLatency), in ms.
      heardEstimateDisagreementMs: roundSummary(summarize(this.sHeardDiff.values())),
      worklet: this.shared
        ? {
            callbacks: Atomics.load(this.shared, 1),
            // Render quanta the processor was not called for (the frame counter jumped).
            discontinuities: Atomics.load(this.shared, 2),
            lastDiscontinuity:
              Atomics.load(this.shared, 2) > 0
                ? {
                    atContextSeconds: round(Atomics.load(this.shared, 4) / ctx.sampleRate, 3),
                    gapMs: round((Atomics.load(this.shared, 3) / ctx.sampleRate) * 1000, 2),
                  }
                : null,
            // How far rendering runs ahead of / behind real time, sampled every 50 ms.
            renderedFrameVsClockMs: roundSummary(summarize(frameResiduals)),
          }
        : 'unavailable (no SharedArrayBuffer)',
      playbackStats: playback ?? 'unavailable',
      clicksPlayed: this.clicksPlayed,
      microphone: this.mic ? this.mic.getAudioTracks()[0]?.getSettings() ?? true : false,
    };
  }
}
