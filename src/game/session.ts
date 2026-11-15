// The page's side of a game: owns the canvas and the worker, publishes the audio clock,
// stamps keyboard input into the shared ring, and starts the music.
//
// The page must be cross-origin isolated (shared memory). The audio engine is the caller's:
// one for the whole visit, never suspended (docs/LATENCY.md section 7).

import type { AudioEngine } from '../audio/engine.ts';
import type { SimfileFormat } from '../chart/index.ts';
import { EventRing } from '../shared/ring.ts';
import { DEFAULT_BINDINGS, type Bindings } from './bindings.ts';
import { InputRouter } from './input.ts';
import {
  DEFAULT_SETTINGS,
  INPUT_FIELDS,
  INPUT_INJECTED,
  INPUT_RING_CAPACITY,
  type FromWorker,
  type InitMessage,
  type PlaySettings,
  type ReportLog,
  type Results,
  type Telemetry,
} from './protocol.ts';
import { SHARED_CLOCK_BYTES, SharedClock } from './shared-clock.ts';

export interface SessionOptions {
  simfile: Uint8Array;
  format: SimfileFormat;
  path: string;
  chartIndex: number;
  settings?: Partial<PlaySettings>;
  /** The first note comes at least this long after the start (ScreenGameplay MinSecondsToStep). */
  minSecondsToStep?: number;
  /** The music starts at least this long after the start (MinSecondsToMusic). */
  minSecondsToMusic?: number;
  /** Which controls are which panels; used when no `input` is given. */
  bindings?: Bindings;
  /** The page's input router, when it has one that outlives the game (pads stay open). */
  input?: InputRouter;
  /** Effect sound id (AudioEngine.loadSound) played when a mine is hit. */
  mineSound?: number;
}

export interface SessionReport {
  results: Results;
  telemetry: Telemetry;
  log: ReportLog | null;
}

export interface ChartInfo {
  title: string;
  notes: number;
  firstSeconds: number;
  lastSeconds: number;
  tracks: number;
}

function pixelSize(host: HTMLElement): { width: number; height: number } {
  const dpr = window.devicePixelRatio || 1;
  return { width: Math.max(1, Math.round(host.clientWidth * dpr)), height: Math.max(1, Math.round(host.clientHeight * dpr)) };
}

export class GameSession {
  readonly info: ChartInfo;
  /** Music time at which the session started playing (negative: a lead-in). */
  readonly startSeconds: number;
  /** Called once when every note has been judged and the song is over. */
  onFinished: ((results: Results) => void) | null = null;
  onError: ((message: string) => void) | null = null;

  private readonly engine: AudioEngine;
  private readonly worker: Worker;
  private readonly ring: EventRing;
  private readonly clock: SharedClock;
  private readonly host: HTMLElement;
  private readonly observer: ResizeObserver;
  private readonly input: InputRouter;
  private readonly ownsInput: boolean;
  private readonly mineSound: number | undefined;
  private pausedAt: number | null = null;
  private readonly globalOffsetSeconds: number;
  private waiters: ((report: SessionReport | null) => void)[] = [];
  private stopped = false;

  private constructor(engine: AudioEngine, worker: Worker, ring: EventRing, clock: SharedClock, host: HTMLElement, info: ChartInfo, options: SessionOptions) {
    this.engine = engine;
    this.worker = worker;
    this.ring = ring;
    this.clock = clock;
    this.host = host;
    this.info = info;
    this.ownsInput = !options.input;
    this.input = options.input ?? new InputRouter(options.bindings ?? { ...DEFAULT_BINDINGS });
    this.mineSound = options.mineSound;
    this.globalOffsetSeconds = (options.settings?.globalOffsetMs ?? DEFAULT_SETTINGS.globalOffsetMs) / 1000;

    worker.onmessage = this.onMessage;
    this.observer = new ResizeObserver(() => {
      const size = pixelSize(host);
      worker.postMessage({ type: 'resize', width: size.width, height: size.height });
    });
    this.observer.observe(host);

    // The music: a silent lead-in so that the first note is not on top of the start.
    const toStep = options.minSecondsToStep ?? 3;
    const toMusic = options.minSecondsToMusic ?? 1;
    const from = Math.min(-toMusic, info.firstSeconds - toStep);
    const play = engine.playMusic({ fromSeconds: from, delaySeconds: 0.1 });
    this.startSeconds = play.fromSeconds;
    engine.onClockChanged = this.publish;
    this.publish();

    this.input.releaseAll();
    this.input.setRing(ring);
    if (this.ownsInput) this.input.start();
  }

  get paused(): boolean {
    return this.pausedAt !== null;
  }

  /** Stops the music where it is. The audio context keeps running. */
  pause(): void {
    if (this.stopped || this.pausedAt !== null) return;
    this.pausedAt = this.engine.musicSecondsAt() ?? this.startSeconds;
    this.engine.stopMusic(0.02);
    this.publish();
  }

  /** Goes on from where pause() stopped, after `leadSeconds` of the music played again. */
  resume(leadSeconds = 1): void {
    if (this.stopped || this.pausedAt === null) return;
    // What was held when the game paused may have been let go since; the game heard none of it.
    this.input.releaseAll();
    const at = this.pausedAt;
    this.engine.playMusic({ fromSeconds: at - leadSeconds, delaySeconds: 0.1 });
    this.pausedAt = null;
    this.publish();
    // After the clock is published (the worker throws inputs away while nothing plays), and
    // stamped with the moment the music comes back to where it stopped.
    const stamp = this.engine.perfTimeOfMusic(at) ?? performance.now();
    for (let track = 0; track < this.info.tracks; track++) this.ring.push([INPUT_INJECTED, track, 0, stamp]);
  }

  /** Shows a picture behind the field, darkened to `dim` (0 black .. 1 as it is). */
  setBackground(bitmap: ImageBitmap, dim = 0.35): void {
    if (this.stopped) return;
    this.worker.postMessage({ type: 'background', bitmap, dim }, [bitmap]);
  }

  /**
   * Starts a game in `host` (the canvas fills it). The engine must have its music loaded.
   * Resolves when the worker has the chart and the music has been started.
   */
  static async start(host: HTMLElement, engine: AudioEngine, options: SessionOptions): Promise<GameSession> {
    if (typeof SharedArrayBuffer === 'undefined' || !globalThis.crossOriginIsolated) {
      throw new Error('The page is not cross-origin isolated: shared memory is not available');
    }
    if (!engine.musicInfo) throw new Error('No music is loaded');
    const ring = EventRing.create(INPUT_RING_CAPACITY, INPUT_FIELDS, true);
    const clock = new SharedClock(new SharedArrayBuffer(SHARED_CLOCK_BYTES));
    const probe = new SharedArrayBuffer(8);

    // The clock map needs a few pairs before it can be trusted: 50 ms apart.
    for (let waited = 0; !engine.clock.fitted && waited < 3000; waited += 25) await new Promise((r) => setTimeout(r, 25));
    if (engine.clock.samples === 0) throw new Error('The audio clock gave no output timestamps');

    const canvas = document.createElement('canvas'); // a canvas can be handed over only once
    const size = pixelSize(host);
    canvas.width = size.width;
    canvas.height = size.height;
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.display = 'block';
    host.replaceChildren(canvas);
    const offscreen = canvas.transferControlToOffscreen();

    const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    let info: ChartInfo;
    try {
      info = await new Promise<ChartInfo>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('The game worker did not start')), 10000);
        worker.onerror = (e) => {
          clearTimeout(timer);
          reject(new Error(e.message || 'The game worker failed to load'));
        };
        worker.onmessage = (e: MessageEvent) => {
          const msg = e.data as FromWorker;
          if (msg.type === 'clock-ready') {
            // Publish this thread's clock for 25 ms: the worker measures its own against it.
            const view = new Float64Array(probe);
            const end = performance.now() + 25;
            for (let t = performance.now(); t < end; t = performance.now()) view[0] = t;
          } else if (msg.type === 'ready') {
            clearTimeout(timer);
            resolve({ title: msg.title, notes: msg.notes, firstSeconds: msg.firstSeconds, lastSeconds: msg.lastSeconds, tracks: msg.tracks });
          } else if (msg.type === 'error') {
            clearTimeout(timer);
            reject(new Error(msg.message));
          }
        };
        const init: InitMessage = {
          type: 'init',
          canvas: offscreen,
          mainOrigin: performance.timeOrigin,
          ring: ring.buffer as SharedArrayBuffer,
          clock: clock.buffer as SharedArrayBuffer,
          probe,
          simfile: options.simfile,
          format: options.format,
          path: options.path,
          chartIndex: options.chartIndex,
          settings: { ...DEFAULT_SETTINGS, ...options.settings },
        };
        worker.postMessage(init, [offscreen]);
      });
    } catch (error) {
      worker.terminate();
      host.replaceChildren();
      throw error;
    }
    return new GameSession(engine, worker, ring, clock, host, info, options);
  }

  /** Writes the clock map and the music's place on it where the worker reads them. */
  private publish = (): void => {
    const map = this.engine.clock;
    if (map.samples === 0) return; // started afresh: the worker keeps the last line until there is a new one
    this.clock.write(map.fitPerf, map.fitContext, map.fitSlope, this.engine.musicOffsetSeconds);
  };

  /** For tests: an input with a chosen timestamp (ms, this page's performance clock). */
  inject(track: number, down: boolean, timeStampMs: number): void {
    this.ring.push([INPUT_INJECTED, track, down ? 1 : 0, timeStampMs]);
  }

  /** Performance time (ms) at which the game is at music time `seconds` (global offset included). */
  perfTimeOfMusic(seconds: number): number | null {
    return this.engine.perfTimeOfMusic(seconds - this.globalOffsetSeconds);
  }

  private onMessage = (e: MessageEvent): void => {
    const msg = e.data as FromWorker;
    if (msg.type === 'mine') {
      if (this.mineSound !== undefined) this.engine.playSound(this.mineSound, { gain: 0.6 });
    } else if (msg.type === 'finished') {
      this.onFinished?.(msg.results);
    } else if (msg.type === 'report') {
      const waiters = this.waiters;
      this.waiters = [];
      for (const done of waiters) done({ results: msg.results, telemetry: msg.telemetry, log: msg.log });
    } else if (msg.type === 'error') {
      this.onError?.(msg.message);
    }
  };

  private request(type: 'report' | 'stop'): Promise<SessionReport | null> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), 2000);
      this.waiters.push((report) => {
        clearTimeout(timer);
        resolve(report);
      });
      this.worker.postMessage({ type });
    });
  }

  /** Results and timing figures so far. */
  report(): Promise<SessionReport | null> {
    return this.stopped ? Promise.resolve(null) : this.request('report');
  }

  /** Ends the game: stops the music (the audio context keeps running) and the worker. */
  async stop(fadeSeconds = 0.3): Promise<SessionReport | null> {
    if (this.stopped) return null;
    this.input.setRing(null);
    if (this.ownsInput) this.input.stop();
    this.observer.disconnect();
    if (this.engine.onClockChanged === this.publish) this.engine.onClockChanged = null;
    this.engine.stopMusic(fadeSeconds);
    const report = await this.request('stop');
    this.stopped = true;
    this.worker.terminate();
    this.host.replaceChildren();
    return report;
  }
}
