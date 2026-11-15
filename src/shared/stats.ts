// Small statistics helpers. Pure: no browser or Node dependencies.

/** Growable store of numbers. Growth allocates; size it up front for hot paths. */
export class Series {
  private buf: Float64Array;
  private readonly max: number;
  n = 0;
  dropped = 0;

  constructor(initial = 1024, max = 1 << 20) {
    this.buf = new Float64Array(initial);
    this.max = max;
  }

  push(v: number): void {
    if (this.n === this.buf.length) {
      if (this.n >= this.max) {
        this.dropped++;
        return;
      }
      const next = new Float64Array(Math.min(this.buf.length * 2, this.max));
      next.set(this.buf);
      this.buf = next;
    }
    this.buf[this.n++] = v;
  }

  values(): Float64Array {
    return this.buf.subarray(0, this.n);
  }

  clear(): void {
    this.n = 0;
    this.dropped = 0;
  }
}

export interface Summary {
  n: number;
  min: number;
  max: number;
  mean: number;
  sd: number;
  p50: number;
  p95: number;
  p99: number;
  /** 99th percentile of |x - median|. This is the jitter figure the targets use. */
  jitterP99: number;
}

/** Quantile of an ascending-sorted array, linear interpolation between ranks. */
export function quantile(sorted: ArrayLike<number>, q: number): number {
  const n = sorted.length;
  if (n === 0) return NaN;
  const pos = Math.min(Math.max(q, 0), 1) * (n - 1);
  const lo = Math.floor(pos);
  const hi = Math.min(lo + 1, n - 1);
  return sorted[lo] + (pos - lo) * (sorted[hi] - sorted[lo]);
}

export function summarize(values: ArrayLike<number>): Summary | null {
  const n = values.length;
  if (n === 0) return null;
  const s = Float64Array.from(values).sort();
  let sum = 0;
  for (let i = 0; i < n; i++) sum += s[i];
  const mean = sum / n;
  let sq = 0;
  for (let i = 0; i < n; i++) sq += (s[i] - mean) * (s[i] - mean);
  const p50 = quantile(s, 0.5);
  const dev = new Float64Array(n);
  for (let i = 0; i < n; i++) dev[i] = Math.abs(s[i] - p50);
  dev.sort();
  return {
    n,
    min: s[0],
    max: s[n - 1],
    mean,
    sd: n > 1 ? Math.sqrt(sq / (n - 1)) : 0,
    p50,
    p95: quantile(s, 0.95),
    p99: quantile(s, 0.99),
    jitterP99: quantile(dev, 0.99),
  };
}

export function round(x: number, digits = 3): number {
  if (!Number.isFinite(x)) return x;
  const f = 10 ** digits;
  return Math.round(x * f) / f;
}

export function roundSummary(s: Summary | null, digits = 3): Summary | null {
  if (!s) return null;
  return {
    n: s.n,
    min: round(s.min, digits),
    max: round(s.max, digits),
    mean: round(s.mean, digits),
    sd: round(s.sd, digits),
    p50: round(s.p50, digits),
    p95: round(s.p95, digits),
    p99: round(s.p99, digits),
    jitterP99: round(s.jitterP99, digits),
  };
}

export interface Histogram {
  start: number;
  binWidth: number;
  counts: number[];
  below: number;
  above: number;
}

export function histogram(values: ArrayLike<number>, start: number, binWidth: number, bins: number): Histogram {
  const counts = new Array<number>(bins).fill(0);
  let below = 0;
  let above = 0;
  for (let i = 0; i < values.length; i++) {
    const b = Math.floor((values[i] - start) / binWidth);
    if (b < 0) below++;
    else if (b >= bins) above++;
    else counts[b]++;
  }
  return { start, binWidth, counts, below, above };
}

export interface LinearFit {
  n: number;
  slope: number;
  intercept: number;
  /** RMS of residuals y - (intercept + slope x). */
  rms: number;
  maxAbs: number;
}

/** Least-squares line through (x, y). x is centred internally for numerical stability. */
export function linearFit(x: ArrayLike<number>, y: ArrayLike<number>): LinearFit | null {
  const n = Math.min(x.length, y.length);
  if (n < 2) return null;
  let xm = 0;
  let ym = 0;
  for (let i = 0; i < n; i++) {
    xm += x[i];
    ym += y[i];
  }
  xm /= n;
  ym /= n;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i] - xm;
    sxx += dx * dx;
    sxy += dx * (y[i] - ym);
  }
  if (sxx === 0) return null;
  const slope = sxy / sxx;
  const intercept = ym - slope * xm;
  let sq = 0;
  let maxAbs = 0;
  for (let i = 0; i < n; i++) {
    const r = y[i] - (ym + slope * (x[i] - xm));
    sq += r * r;
    if (Math.abs(r) > maxAbs) maxAbs = Math.abs(r);
  }
  return { n, slope, intercept, rms: Math.sqrt(sq / n), maxAbs };
}
