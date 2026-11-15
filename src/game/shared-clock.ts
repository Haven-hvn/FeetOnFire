// The audio clock map, shared between threads. Pure: no browser dependencies.
//
// The map from the performance clock to the audio being heard lives on the main thread
// (AudioContext.getOutputTimestamp() exists only there). The game worker judges and draws by
// music time, so the main thread publishes the map's line and the music's position on it
// into shared memory, and the worker reads them:
//
//   music seconds heard at main-thread time p = musicOffset + context + (p - perf) * slope
//
// A sequence counter makes a reader see either the old set of numbers or the new one, never
// a mixture: it is odd while a write is under way and changes with every write.

const HEADER_BYTES = 8;
const PERF = 0;
const CONTEXT = 1;
const SLOPE = 2;
const MUSIC_OFFSET = 3;
const PLAYING = 4;
const FIELDS = 5;

export const SHARED_CLOCK_BYTES = HEADER_BYTES + FIELDS * 8;

export class SharedClock {
  readonly buffer: SharedArrayBuffer | ArrayBuffer;
  private readonly seq: Int32Array;
  private readonly data: Float64Array;

  // The reader's copy.
  private perf = 0;
  private context = 0;
  private slope = 1e-3;
  private musicOffset = 0;
  /** True while music is placed on the clock (after read()). */
  playing = false;
  /** The sequence number of the last set read: changes when the map does. */
  version = -1;

  constructor(buffer: SharedArrayBuffer | ArrayBuffer = SharedClock.allocate()) {
    this.buffer = buffer;
    this.seq = new Int32Array(buffer, 0, 1);
    this.data = new Float64Array(buffer, HEADER_BYTES, FIELDS);
  }

  static allocate(): SharedArrayBuffer | ArrayBuffer {
    return typeof SharedArrayBuffer !== 'undefined' && globalThis.crossOriginIsolated === true
      ? new SharedArrayBuffer(SHARED_CLOCK_BYTES)
      : new ArrayBuffer(SHARED_CLOCK_BYTES);
  }

  /**
   * Writer side. `musicOffsetSeconds` is music seconds minus heard context seconds; null
   * when no music is playing.
   */
  write(fitPerf: number, fitContext: number, fitSlope: number, musicOffsetSeconds: number | null): void {
    Atomics.add(this.seq, 0, 1);
    this.data[PERF] = fitPerf;
    this.data[CONTEXT] = fitContext;
    this.data[SLOPE] = fitSlope;
    this.data[MUSIC_OFFSET] = musicOffsetSeconds ?? 0;
    this.data[PLAYING] = musicOffsetSeconds === null ? 0 : 1;
    Atomics.add(this.seq, 0, 1);
  }

  /** Reader side: takes the current set. Returns `playing`. */
  read(): boolean {
    for (let tries = 0; tries < 1000; tries++) {
      const before = Atomics.load(this.seq, 0);
      if (before & 1) continue;
      const perf = this.data[PERF]!;
      const context = this.data[CONTEXT]!;
      const slope = this.data[SLOPE]!;
      const musicOffset = this.data[MUSIC_OFFSET]!;
      const playing = this.data[PLAYING] === 1;
      if (Atomics.load(this.seq, 0) !== before) continue;
      this.perf = perf;
      this.context = context;
      this.slope = slope;
      this.musicOffset = musicOffset;
      this.playing = playing;
      this.version = before;
      break;
    }
    return this.playing;
  }

  /** Music seconds heard at main-thread performance time `perfMs`, by the set last read. */
  musicSecondsAt(perfMs: number): number {
    return this.musicOffset + this.context + (perfMs - this.perf) * this.slope;
  }

  /** Main-thread performance time at which music time `seconds` is heard. */
  perfTimeOfMusic(seconds: number): number {
    return this.perf + (seconds - this.musicOffset - this.context) / this.slope;
  }
}
