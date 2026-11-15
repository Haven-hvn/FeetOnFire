// Sample rate conversion that keeps time: output frame j is the input at time j / toRate, with
// no delay added or removed, so music time 0 stays at frame 0. Pure: no browser dependencies.
//
// Band-limited interpolation with a Kaiser-windowed sinc, centred on the exact position of each
// output frame. For the usual rate pairs (44100 and 48000 and their simple multiples) every
// position falls on one of a small number of phases and the kernel for each is exact; for
// other pairs the kernel is interpolated between 1024 phases.

/** Zero crossings of the sinc on each side of the centre. */
const ZERO_CROSSINGS = 32;
/** Kaiser window shape: about 80 dB of stop-band attenuation. */
const BETA = 8;
/** The pass band ends a little below the lower of the two Nyquist frequencies. */
const ROLLOFF = 0.95;
const MAX_PHASES = 1024;

function gcd(a: number, b: number): number {
  while (b !== 0) [a, b] = [b, a % b];
  return a;
}

/** Zeroth-order modified Bessel function of the first kind. */
function bessel0(x: number): number {
  let sum = 1;
  let term = 1;
  const half = x / 2;
  for (let k = 1; k < 64; k++) {
    term *= (half / k) * (half / k);
    sum += term;
    if (term < sum * 1e-17) break;
  }
  return sum;
}

interface Kernel {
  /** Output frames per `step` input frames. */
  up: number;
  step: number;
  /** Phases in the table; the table has one more row, for interpolating. */
  phases: number;
  /** Input frames on each side of a position. */
  half: number;
  taps: number;
  table: Float32Array;
}

const kernels = new Map<string, Kernel>();

function kernelFor(from: number, to: number): Kernel {
  const key = `${from}:${to}`;
  const cached = kernels.get(key);
  if (cached) return cached;

  const g = gcd(from, to);
  const up = to / g;
  const step = from / g;
  const phases = Math.min(up, MAX_PHASES);
  // Relative to the input's Nyquist frequency. Below 1 when the output rate is lower.
  const cutoff = ROLLOFF * Math.min(1, to / from);
  const half = Math.ceil(ZERO_CROSSINGS / cutoff);
  const taps = 2 * half;
  const table = new Float32Array((phases + 1) * taps);
  const norm = bessel0(BETA);
  const row = new Float64Array(taps);
  for (let p = 0; p <= phases; p++) {
    const fraction = p / phases;
    let sum = 0;
    for (let t = 0; t < taps; t++) {
      // Distance, in input frames, from the output position to input frame (base - half + 1 + t).
      const x = t - half + 1 - fraction;
      const w = Math.abs(x) / half;
      let value = 0;
      if (w < 1) {
        const a = Math.PI * cutoff * x;
        const sinc = x === 0 ? 1 : Math.sin(a) / a;
        value = cutoff * sinc * (bessel0(BETA * Math.sqrt(1 - w * w)) / norm);
      }
      row[t] = value;
      sum += value;
    }
    // Unity gain at 0 Hz for every phase.
    for (let t = 0; t < taps; t++) table[p * taps + t] = row[t]! / sum;
  }
  const kernel: Kernel = { up, step, phases, half, taps, table };
  kernels.set(key, kernel);
  return kernel;
}

/** Frames `frames` at rate `from` become at rate `to`. */
export function resampledLength(frames: number, from: number, to: number): number {
  if (from === to) return frames;
  const g = gcd(from, to);
  return Math.ceil((frames * (to / g)) / (from / g));
}

/**
 * Converts one channel from rate `from` to rate `to` (both whole numbers of hertz). Input
 * outside the array counts as silence. `out`, when given, must hold resampledLength() frames.
 * With equal rates the input is copied.
 */
export function resample(input: Float32Array, from: number, to: number, out?: Float32Array): Float32Array {
  if (!Number.isInteger(from) || !Number.isInteger(to) || from <= 0 || to <= 0) throw new RangeError(`Invalid sample rates ${from} -> ${to}`);
  const n = input.length;
  const length = resampledLength(n, from, to);
  const output = out ?? new Float32Array(length);
  if (output.length < length) throw new RangeError('Output array is too short');
  if (from === to) {
    output.set(input);
    return output;
  }

  const { up, step, phases, half, taps, table } = kernelFor(from, to);
  const exact = phases === up;
  const wholeStep = Math.floor(step / up);
  const partStep = step % up;
  let base = 0; // whole input frames of the position
  let part = 0; // the rest, in units of 1/up
  for (let j = 0; j < length; j++) {
    const first = base - half + 1;
    const tFrom = first < 0 ? -first : 0;
    const tTo = first + taps > n ? n - first : taps;
    let sum = 0;
    if (exact) {
      const row = part * taps;
      for (let t = tFrom; t < tTo; t++) sum += input[first + t]! * table[row + t]!;
    } else {
      const position = (part * phases) / up;
      const p = Math.floor(position);
      const mix = position - p;
      const row = p * taps;
      const next = row + taps;
      for (let t = tFrom; t < tTo; t++) {
        const a = table[row + t]!;
        sum += input[first + t]! * (a + (table[next + t]! - a) * mix);
      }
    }
    output[j] = sum;

    base += wholeStep;
    part += partStep;
    if (part >= up) {
      part -= up;
      base++;
    }
  }
  return output;
}
