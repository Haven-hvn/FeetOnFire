// Sounds made here rather than loaded: nothing to ship, nothing to license.

import type { DecodedAudio } from '../audio/pcm.ts';

function audio(samples: Float32Array, sampleRate: number): DecodedAudio {
  return { sampleRate, channels: [samples], frames: samples.length, format: 'wav', decoder: 'wav', notes: [] };
}

/** A mine going off: a short burst of noise falling in pitch. */
export function mineSound(sampleRate: number): DecodedAudio {
  const n = Math.round(sampleRate * 0.35);
  const out = new Float32Array(n);
  let seed = 22222;
  let low = 0;
  for (let i = 0; i < n; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const noise = seed / 0x3fffffff - 1;
    const t = i / n;
    // A low-pass that closes as the sound dies away.
    low += (noise - low) * (0.5 * (1 - t) + 0.02);
    const thump = Math.sin(2 * Math.PI * (90 - 50 * t) * (i / sampleRate));
    out[i] = (low * 0.7 + thump * 0.5) * Math.pow(1 - t, 2.5);
  }
  return audio(out, sampleRate);
}

/** A short tone that glides from one pitch to another: the menu's sounds. */
function blip(sampleRate: number, fromHz: number, toHz: number, seconds: number, level: number): DecodedAudio {
  const n = Math.round(sampleRate * seconds);
  const out = new Float32Array(n);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / n;
    phase += (2 * Math.PI * (fromHz + (toHz - fromHz) * t)) / sampleRate;
    // A quick rise so that it does not click, then a fall.
    const envelope = Math.min(1, i / (sampleRate * 0.004)) * Math.pow(1 - t, 2);
    out[i] = (Math.sin(phase) + 0.3 * Math.sin(2 * phase)) * envelope * level;
  }
  return audio(out, sampleRate);
}

export const SFX = { mine: 0, move: 1, confirm: 2, back: 3 } as const;
export type SfxName = keyof typeof SFX;

export function menuSounds(sampleRate: number): [number, DecodedAudio][] {
  return [
    [SFX.move, blip(sampleRate, 880, 990, 0.05, 0.22)],
    [SFX.confirm, blip(sampleRate, 660, 1320, 0.16, 0.3)],
    [SFX.back, blip(sampleRate, 520, 330, 0.12, 0.25)],
  ];
}

export const CLICK_FIRST_SECONDS = 1;
export const CLICK_INTERVAL_SECONDS = 0.5;
export const CLICK_COUNT = 28;

/** The calibration track: short clicks, evenly spaced, as "music". */
export function clickTrack(sampleRate: number): DecodedAudio {
  const total = Math.round(sampleRate * (CLICK_FIRST_SECONDS + CLICK_COUNT * CLICK_INTERVAL_SECONDS + 1));
  const out = new Float32Array(total);
  const length = Math.round(sampleRate * 0.03);
  for (let k = 0; k < CLICK_COUNT; k++) {
    const start = Math.round(sampleRate * (CLICK_FIRST_SECONDS + k * CLICK_INTERVAL_SECONDS));
    for (let i = 0; i < length; i++) {
      // Starts at full level on its first sample: the onset is the click's time.
      out[start + i] = Math.cos(2 * Math.PI * 1500 * (i / sampleRate)) * Math.pow(1 - i / length, 3) * 0.8;
    }
  }
  return audio(out, sampleRate);
}

/** Median and half the spread between the quartiles of tap errors (ms). */
export function summarizeTaps(errorsMs: readonly number[]): { median: number; spread: number; n: number } | null {
  if (errorsMs.length === 0) return null;
  const sorted = [...errorsMs].sort((a, b) => a - b);
  const at = (q: number): number => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
  const mid = sorted.length % 2 ? sorted[(sorted.length - 1) / 2]! : (sorted[sorted.length / 2 - 1]! + sorted[sorted.length / 2]!) / 2;
  return { median: mid, spread: (at(0.75) - at(0.25)) / 2, n: sorted.length };
}

/** How far a tap at music time `seconds` is from the nearest click, ms (positive: late); null when not near one. */
export function tapError(seconds: number): number | null {
  const k = Math.round((seconds - CLICK_FIRST_SECONDS) / CLICK_INTERVAL_SECONDS);
  if (k < 0 || k >= CLICK_COUNT) return null;
  return (seconds - (CLICK_FIRST_SECONDS + k * CLICK_INTERVAL_SECONDS)) * 1000;
}
