// Signal helpers for the acoustic (microphone) tests. Pure: no browser dependencies.

/** Test click: a short Hann-windowed chirp, easy to locate by correlation. */
export function makeClick(sampleRate: number, durationMs = 3, f0 = 2000, f1 = 6000, peak = 0.9): Float32Array {
  const n = Math.max(8, Math.round((sampleRate * durationMs) / 1000));
  const out = new Float32Array(n);
  const T = n / sampleRate;
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const phase = 2 * Math.PI * (f0 * t + ((f1 - f0) * t * t) / (2 * T));
    const win = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
    out[i] = peak * win * Math.sin(phase);
  }
  return out;
}

export interface TemplateMatch {
  /** Start position of the best match in `signal`, in samples (fractional). */
  index: number;
  /** Normalised correlation at the best match, 0..1: how click-shaped the signal is there. */
  score: number;
  /**
   * Best correlation divided by the RMS correlation over the whole search range. This is
   * the detection statistic: noise alone gives about sqrt(2 ln(lags)), 4 to 5 for a
   * half-second search, so 8 or more is a real click.
   */
  prominence: number;
  /** Raw correlation magnitude at the best match. */
  peak: number;
}

/** Find `template` in `signal`, searching start positions in [from, to]. */
export function findTemplate(signal: Float32Array, template: Float32Array, from: number, to: number): TemplateMatch | null {
  const m = template.length;
  const lo = Math.max(0, Math.floor(from));
  const hi = Math.min(signal.length - m, Math.ceil(to));
  if (hi < lo) return null;

  const corr = new Float32Array(hi - lo + 1);
  let best = lo;
  let bestAbs = -1;
  let sumSq = 0;
  for (let lag = lo; lag <= hi; lag++) {
    let c = 0;
    for (let k = 0; k < m; k++) c += signal[lag + k] * template[k];
    const a = Math.abs(c);
    corr[lag - lo] = a;
    sumSq += c * c;
    if (a > bestAbs) {
      bestAbs = a;
      best = lag;
    }
  }

  let es = 0;
  let et = 0;
  for (let k = 0; k < m; k++) {
    es += signal[best + k] * signal[best + k];
    et += template[k] * template[k];
  }
  const score = es > 0 && et > 0 ? bestAbs / Math.sqrt(es * et) : 0;

  let frac = 0;
  if (best > lo && best < hi) {
    const y0 = corr[best - 1 - lo];
    const y2 = corr[best + 1 - lo];
    const d = y0 - 2 * bestAbs + y2;
    if (d < 0) frac = (0.5 * (y0 - y2)) / d;
  }
  const rms = Math.sqrt(sumSq / corr.length);
  return { index: best + frac, score, prominence: rms > 0 ? bestAbs / rms : 0, peak: bestAbs };
}

export interface Onset {
  /** Sample index where the transient starts. */
  index: number;
  /** Peak short-term power of the transient relative to the noise floor. */
  strength: number;
}

export interface OnsetOptions {
  /** Minimum spacing between reported onsets. */
  minGapMs?: number;
  /** Detection threshold as a multiple of the median short-term power. */
  ratio?: number;
}

/**
 * Detect broadband transients (a foot or finger landing) in a recording.
 * Works on the first difference of the signal, which suppresses hum and rumble.
 */
export function detectOnsets(signal: Float32Array, sampleRate: number, options: OnsetOptions = {}): Onset[] {
  const minGap = Math.round(((options.minGapMs ?? 120) * sampleRate) / 1000);
  const ratio = options.ratio ?? 50;
  const n = signal.length;
  const w = Math.max(2, Math.round(sampleRate / 1000)); // 1 ms power window
  if (n < w * 4) return [];

  // Short-term power of the differenced signal; env[i] covers samples (i - w, i].
  const env = new Float32Array(n);
  let acc = 0;
  let prev = signal[0];
  const sq = new Float32Array(n);
  for (let i = 1; i < n; i++) {
    const d = signal[i] - prev;
    prev = signal[i];
    sq[i] = d * d;
    acc += sq[i];
    if (i >= w) acc -= sq[i - w];
    env[i] = acc / w;
  }

  // Noise floor: median of a subsample of the envelope.
  const step = Math.max(1, Math.floor(n / 4096));
  const sample: number[] = [];
  for (let i = w; i < n; i += step) sample.push(env[i]);
  sample.sort((a, b) => a - b);
  const floor = Math.max(sample[Math.floor(sample.length / 2)], 1e-12);
  const threshold = floor * ratio;

  const onsets: Onset[] = [];
  const look = Math.round(sampleRate * 0.02);
  let i = w;
  while (i < n) {
    if (env[i] <= threshold) {
      i++;
      continue;
    }
    // Local peak within the next 20 ms.
    let peak = env[i];
    const end = Math.min(n, i + look);
    for (let j = i; j < end; j++) if (env[j] > peak) peak = env[j];
    // Walk back from the threshold crossing to where the transient rises out of the floor.
    const rise = Math.max(threshold, peak * 0.02);
    let start = i;
    const back = Math.max(w, i - Math.round(sampleRate * 0.005));
    while (start > back && env[start - 1] > rise) start--;
    onsets.push({ index: start, strength: peak / floor });
    i = start + minGap;
  }
  return onsets;
}

export interface TapMatch {
  /** Error (ms) of each tap that agrees with the others: expected minus detected. */
  errorsMs: number[];
  /** Their median, or null when no two taps agree. */
  consensusMs: number | null;
  /** Enough taps agree for the figure to mean something. */
  accepted: boolean;
}

/**
 * Matches taps with detected sounds. A recording holds more sounds than taps (the key coming
 * up, the room), so the nearest sound to each tap is often the wrong one. What marks the right
 * ones is that they sit at the same distance from their taps: the distance most taps agree on
 * (within `toleranceMs`) is taken, and only the taps that agree are counted.
 *
 * @param expected frame at which each tap's sound should be in the recording
 * @param onsets frames of the detected sounds
 */
export function matchTaps(expected: ArrayLike<number>, onsets: ArrayLike<number>, sampleRate: number, windowMs = 150, toleranceMs = 5): TapMatch {
  const perTap: number[][] = [];
  const candidates: number[] = [];
  for (let i = 0; i < expected.length; i++) {
    const errors: number[] = [];
    for (let j = 0; j < onsets.length; j++) {
      const e = ((expected[i]! - onsets[j]!) / sampleRate) * 1000;
      if (Math.abs(e) <= windowMs) errors.push(e);
    }
    perTap.push(errors);
    candidates.push(...errors);
  }
  const nearest = (errors: number[], to: number): number | null => {
    let best: number | null = null;
    for (const e of errors) if (Math.abs(e - to) <= toleranceMs && (best === null || Math.abs(e - to) < Math.abs(best - to))) best = e;
    return best;
  };
  let bestCount = 0;
  let bestSpread = Infinity;
  let bestErrors: number[] = [];
  for (const c of candidates) {
    const errors: number[] = [];
    let spread = 0;
    for (const tap of perTap) {
      const e = nearest(tap, c);
      if (e === null) continue;
      errors.push(e);
      spread += Math.abs(e - c);
    }
    if (errors.length > bestCount || (errors.length === bestCount && spread < bestSpread)) {
      bestCount = errors.length;
      bestSpread = spread;
      bestErrors = errors;
    }
  }
  if (bestCount < 2) return { errorsMs: [], consensusMs: null, accepted: false };
  const sorted = [...bestErrors].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  const consensusMs = sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
  return { errorsMs: bestErrors, consensusMs, accepted: bestCount >= 8 && bestCount >= 0.6 * expected.length };
}
