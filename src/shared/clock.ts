// Clock handling. Pure: no browser dependencies.
//
// Timebase rule (docs/LATENCY.md section 8): all times are milliseconds on the main
// thread's performance clock. Other threads convert through performance.timeOrigin.

import { Series } from './stats.ts';

/** Convert a `performance.now()` value taken on another thread into the main thread's timebase. */
export function toMainTime(localNow: number, localOrigin: number, mainOrigin: number): number {
  return localNow + (localOrigin - mainOrigin);
}

const NOMINAL = 1e-3; // context seconds per performance millisecond
const MAX_SLOPE_DEVIATION = 1e-3; // 0.1 %: far beyond any real audio clock drift
const MIN_FIT_SAMPLES = 8;
/** A pair this far (ms) from the map's prediction is not added at once: it may be a step. */
const STEP_MS = 1.5;
/** This many such pairs in a row, agreeing with each other, are a step of the clock. */
const STEP_PAIRS = 3;

/**
 * Map between the performance clock and the audio context time *being heard*.
 *
 * Fed with (performanceTime, contextTime) pairs from AudioContext.getOutputTimestamp().
 * Keeps a sliding window and fits a line through it, so a single noisy pair does not
 * move the estimate and slow drift between the audio device clock and the system clock
 * is followed.
 *
 * On a real device the heard position also moves in steps (measured: 4 to 30 ms, when the
 * output device is reconfigured or stalls; docs/LATENCY.md section 7). A window would take
 * its whole length to follow one. So a pair far from the prediction is held back: if the
 * next ones agree with it, the map starts again from them, keeping its rate; if the next
 * one is back in line, it was an outlier and is dropped.
 */
export class AudioClockMap {
  private readonly perf: Float64Array;
  private readonly ctx: Float64Array;
  private count = 0;
  private next = 0;
  private perf0 = 0;
  private ctx0 = 0;
  private slope = NOMINAL;
  private readonly heldPerf = new Float64Array(STEP_PAIRS);
  private readonly heldCtx = new Float64Array(STEP_PAIRS);
  private held = 0;
  private heldError = 0;
  /** Steps of the clock followed so far. */
  steps = 0;
  /** Size of the last step, in milliseconds (positive: the heard position moved ahead). */
  lastStepMs = 0;

  constructor(window = 40) {
    this.perf = new Float64Array(Math.max(window, MIN_FIT_SAMPLES));
    this.ctx = new Float64Array(this.perf.length);
  }

  get samples(): number {
    return this.count;
  }

  // The fitted line, contextTimeAt(p) = fitContext + (p - fitPerf) * fitSlope, for sharing
  // the map with another thread.
  get fitPerf(): number {
    return this.perf0;
  }
  get fitContext(): number {
    return this.ctx0;
  }
  get fitSlope(): number {
    return this.slope;
  }

  /** True once enough pairs have arrived for a fitted (rather than single-pair) estimate. */
  get fitted(): boolean {
    return this.count >= MIN_FIT_SAMPLES;
  }

  reset(): void {
    this.count = 0;
    this.next = 0;
    this.slope = NOMINAL;
    this.held = 0;
  }

  add(perfMs: number, ctxSec: number): void {
    if (this.fitted) {
      const error = (ctxSec - this.contextTimeAt(perfMs)) * 1000;
      if (Math.abs(error) > STEP_MS) {
        if (this.held === 0 || Math.abs(error - this.heldError) <= STEP_MS) {
          if (this.held === 0) this.heldError = error;
          this.heldPerf[this.held] = perfMs;
          this.heldCtx[this.held] = ctxSec;
          if (++this.held < STEP_PAIRS) return;
          // A step: start again from the held pairs, at the rate found so far.
          this.steps++;
          this.lastStepMs = this.heldError;
          this.count = 0;
          this.next = 0;
        }
        // Otherwise: far off, but not where the held pairs are. Noise; all of them count.
        const held = this.held;
        this.held = 0;
        for (let i = 0; i < held; i++) this.put(this.heldPerf[i]!, this.heldCtx[i]!);
        if (held === STEP_PAIRS) return;
      } else {
        this.held = 0; // back in line: what was held were outliers
      }
    }
    this.put(perfMs, ctxSec);
  }

  private put(perfMs: number, ctxSec: number): void {
    this.perf[this.next] = perfMs;
    this.ctx[this.next] = ctxSec;
    this.next = (this.next + 1) % this.perf.length;
    if (this.count < this.perf.length) this.count++;

    if (this.count < MIN_FIT_SAMPLES) {
      // Too few for a rate: the middle of what there is, at the rate found before (if any).
      let perf = 0;
      let ctx = 0;
      for (let i = 0; i < this.count; i++) {
        perf += this.perf[i]!;
        ctx += this.ctx[i]!;
      }
      this.perf0 = perf / this.count;
      this.ctx0 = ctx / this.count;
      return;
    }
    let pm = 0;
    let cm = 0;
    for (let i = 0; i < this.count; i++) {
      pm += this.perf[i];
      cm += this.ctx[i];
    }
    pm /= this.count;
    cm /= this.count;
    let sxx = 0;
    let sxy = 0;
    for (let i = 0; i < this.count; i++) {
      const dx = this.perf[i] - pm;
      sxx += dx * dx;
      sxy += dx * (this.ctx[i] - cm);
    }
    let slope = sxx > 0 ? sxy / sxx : NOMINAL;
    const lo = NOMINAL * (1 - MAX_SLOPE_DEVIATION);
    const hi = NOMINAL * (1 + MAX_SLOPE_DEVIATION);
    if (!(slope >= lo && slope <= hi)) slope = NOMINAL;
    this.perf0 = pm;
    this.ctx0 = cm;
    this.slope = slope;
  }

  /** Audio context time (seconds) being heard at performance time `perfMs`. */
  contextTimeAt(perfMs: number): number {
    return this.ctx0 + (perfMs - this.perf0) * this.slope;
  }

  /** Performance time (ms) at which context time `ctxSec` is heard. */
  perfTimeAt(ctxSec: number): number {
    return this.perf0 + (ctxSec - this.ctx0) / this.slope;
  }
}

/**
 * Replay recorded pairs through an AudioClockMap and return, for each pair, how far the
 * map's prediction made from earlier pairs was from the pair itself (milliseconds).
 * This is the clock-map error the game would actually have experienced.
 */
export function predictionErrors(perfMs: ArrayLike<number>, ctxSec: ArrayLike<number>, window = 40): Series {
  const out = new Series(Math.max(16, perfMs.length));
  const map = new AudioClockMap(window);
  const n = Math.min(perfMs.length, ctxSec.length);
  let started = false;
  for (let i = 0; i < n; i++) {
    // From the first fitted map on, also while the map starts again after a step.
    if (map.fitted) started = true;
    if (started) out.push((ctxSec[i] - map.contextTimeAt(perfMs[i])) * 1000);
    map.add(perfMs[i], ctxSec[i]);
  }
  return out;
}
