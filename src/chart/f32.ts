// 32-bit float and C integer arithmetic, as StepMania's C++ does it.
//
// StepMania keeps beats and seconds in `float`. To get the same note times, every arithmetic
// step here is rounded to 32 bits with Math.fround, in the same order as the C++ expression.
// (A double result rounded once to 32 bits equals the 32-bit result for + - * /.)

export const f32 = Math.fround;

export const FLT_MAX = 3.4028234663852886e38;
export const INT_MAX = 2147483647;

export const ROWS_PER_BEAT = 48;
export const BEATS_PER_MEASURE = 4;
/** NoteTypes.h MAX_NOTE_ROW: the "no tail yet" hold length. */
export const MAX_NOTE_ROW = 1 << 30;

/**
 * `int r = std::lrint(x)` on LP64 arm64/x86-64: round half to even to a 64-bit long, then keep
 * the low 32 bits. Out of long range saturates first (arm64), NaN gives 0.
 */
export function lrintToInt(x: number): number {
  if (Number.isNaN(x)) return 0;
  if (x >= 9223372036854775808) return -1; // LONG_MAX, low 32 bits
  if (x <= -9223372036854775808) return 0; // LONG_MIN, low 32 bits
  let r = Math.round(x);
  if (Math.abs(x - Math.trunc(x)) === 0.5) r = 2 * Math.round(x / 2);
  return r | 0; // ToInt32 is the exact value modulo 2^32
}

/** NoteTypes.h BeatToNoteRow. */
export function beatToNoteRow(beat: number): number {
  return lrintToInt(f32(beat * ROWS_PER_BEAT));
}

/** NoteTypes.h NoteRowToBeat. */
export function noteRowToBeat(row: number): number {
  return f32(f32(row) / ROWS_PER_BEAT);
}

/** True when two floats differ by more than TimingSegment's EPSILON (COMPARE_FLOAT). */
export function floatDiffers(a: number, b: number): boolean {
  return Math.abs(f32(a - b)) > 1e-6;
}
