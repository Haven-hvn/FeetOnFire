// C library number parsing and printing, as StepMania's loaders use it:
// strtof (StringToFloat), std::stoi (StringToInt), atoi, and printf("%f").
//
// Input strings are "binary strings": one char per byte of the file (see msd.ts).

import { f32, FLT_MAX } from './f32.ts';

function isSpace(c: number): boolean {
  return c === 32 || (c >= 9 && c <= 13);
}

function isDigit(c: number): boolean {
  return c >= 48 && c <= 57;
}

function hexValue(c: number): number {
  if (c >= 48 && c <= 57) return c - 48;
  if (c >= 97 && c <= 102) return c - 87;
  if (c >= 65 && c <= 70) return c - 55;
  return -1;
}

const scratchF32 = new Float32Array(1);
const scratchU32 = new Uint32Array(scratchF32.buffer);
const scratchF64 = new Float64Array(1);
const scratchU64 = new BigUint64Array(scratchF64.buffer);

/** The next 32-bit float above (or below) a non-negative finite 32-bit float. */
function neighbour32(x: number, up: boolean): number {
  scratchF32[0] = x;
  scratchU32[0] = scratchU32[0]! + (up ? 1 : -1);
  return scratchF32[0]!;
}

/** A positive finite double as mantissa * 2^exponent, exactly. */
function decompose(x: number): { mantissa: bigint; exponent: number } {
  scratchF64[0] = x;
  const bits = scratchU64[0]!;
  const biased = Number((bits >> 52n) & 0x7ffn);
  const fraction = bits & 0xfffffffffffffn;
  if (biased === 0) return { mantissa: fraction, exponent: -1074 };
  return { mantissa: fraction | 0x10000000000000n, exponent: biased - 1075 };
}

/** Sign of (digits * 10^exp10) - x, for positive finite x. 0 also when the input is too long to compare. */
function compareDecimalToDouble(digits: string, exp10: number, x: number): number {
  if (digits.length > 20000 || Math.abs(exp10) > 20000) return 0;
  const { mantissa, exponent } = decompose(x);
  let left = BigInt(digits);
  let right = mantissa;
  if (exp10 >= 0) left *= 10n ** BigInt(exp10);
  else right *= 10n ** BigInt(-exp10);
  if (exponent >= 0) right <<= BigInt(exponent);
  else left <<= BigInt(-exponent);
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Halfway between FLT_MAX and 2^128: decimals at or above it overflow to infinity. */
const OVERFLOW_MIDPOINT = 3.4028235677973366e38;

/**
 * Rounds the positive decimal digits * 10^exp10 to the nearest 32-bit float, ties to even.
 * Going through a double rounds twice; that only goes wrong when the double lands exactly
 * halfway between two floats, and then the exact decimal decides.
 */
function decimalToF32(digits: string, exp10: number): number {
  const d = Number(`${digits}e${exp10}`);
  if (d === 0 || d === Infinity) return d;
  const r = f32(d);
  if (r === d) return r;
  const other = r === Infinity ? FLT_MAX : neighbour32(r, d > r);
  const lo = Math.min(r, other);
  const hi = Math.max(r, other);
  const mid = hi === Infinity ? OVERFLOW_MIDPOINT : (lo + hi) / 2;
  if (d !== mid) return r;
  const cmp = compareDecimalToDouble(digits, exp10, mid);
  return cmp < 0 ? lo : cmp > 0 ? hi : r;
}

/** Hex float body (after "0x"); null if there are no hex digits. */
function parseHexFloat(s: string, start: number): number | null {
  let i = start;
  let digits = '';
  let fractionDigits = 0;
  while (hexValue(s.charCodeAt(i)) >= 0) digits += s[i++];
  if (s[i] === '.') {
    i++;
    while (hexValue(s.charCodeAt(i)) >= 0) {
      digits += s[i++];
      fractionDigits++;
    }
  }
  if (digits === '') return null;
  let exp2 = 0;
  if (s[i] === 'p' || s[i] === 'P') {
    let k = i + 1;
    let negative = false;
    if (s[k] === '+' || s[k] === '-') negative = s[k++] === '-';
    if (isDigit(s.charCodeAt(k))) {
      while (isDigit(s.charCodeAt(k))) {
        if (exp2 < 100000) exp2 = exp2 * 10 + (s.charCodeAt(k) - 48);
        k++;
      }
      if (negative) exp2 = -exp2;
    }
  }
  exp2 -= 4 * fractionDigits;
  let mantissa = BigInt('0x' + digits);
  if (mantissa === 0n) return 0;
  // Keep 39 bits and a sticky bit: exact in a double, and still rounds correctly to 24 bits.
  const bits = mantissa.toString(2).length;
  if (bits > 40) {
    const shift = BigInt(bits - 40);
    const sticky = (mantissa & ((1n << shift) - 1n)) !== 0n;
    mantissa = (mantissa >> shift) | (sticky ? 1n : 0n);
    exp2 += bits - 40;
  }
  if (exp2 > 300) return Infinity;
  if (exp2 < -400) return 0;
  return f32(Number(mantissa) * 2 ** exp2);
}

/**
 * C `strtof(s, nullptr)` in the "C" locale: the longest valid prefix after leading white space,
 * correctly rounded; 0 when there is none. Can return an infinity or NaN.
 */
export function strtof(s: string): number {
  let i = 0;
  while (isSpace(s.charCodeAt(i))) i++;
  let negative = false;
  if (s[i] === '+' || s[i] === '-') negative = s[i++] === '-';
  const sign = negative ? -1 : 1;

  const word = s.substr(i, 3).toLowerCase();
  if (word === 'inf') return sign * Infinity;
  if (word === 'nan') return NaN;

  if (s[i] === '0' && (s[i + 1] === 'x' || s[i + 1] === 'X')) {
    const hex = parseHexFloat(s, i + 2);
    return sign * (hex ?? 0); // "0x" alone parses as the "0"
  }

  let digits = '';
  let fractionDigits = 0;
  let any = false;
  while (isDigit(s.charCodeAt(i))) {
    any = true;
    if (digits !== '' || s[i] !== '0') digits += s[i];
    i++;
  }
  if (s[i] === '.') {
    i++;
    while (isDigit(s.charCodeAt(i))) {
      any = true;
      fractionDigits++;
      if (digits !== '' || s[i] !== '0') digits += s[i];
      i++;
    }
  }
  if (!any) return 0;
  let exp10 = 0;
  if (s[i] === 'e' || s[i] === 'E') {
    let k = i + 1;
    let negativeExp = false;
    if (s[k] === '+' || s[k] === '-') negativeExp = s[k++] === '-';
    if (isDigit(s.charCodeAt(k))) {
      while (isDigit(s.charCodeAt(k))) {
        if (exp10 < 100000) exp10 = exp10 * 10 + (s.charCodeAt(k) - 48);
        k++;
      }
      if (negativeExp) exp10 = -exp10;
    }
  }
  if (digits === '') return sign * 0;
  return sign * decimalToF32(digits, exp10 - fractionDigits);
}

/** RageUtil StringToFloat: strtof, with infinities and NaN turned into 0. */
export function stringToFloat(s: string): number {
  const value = strtof(s);
  return Number.isFinite(value) ? value : 0;
}

/** The part of a binary string a C function sees through `c_str()`: up to the first NUL. */
export function cString(s: string): string {
  const end = s.indexOf('\0');
  return end < 0 ? s : s.slice(0, end);
}

interface IntegerPrefix {
  /** Digits without leading zeros; '' when the value is zero; null when there are no digits. */
  digits: string | null;
  negative: boolean;
}

function scanInteger(s: string): IntegerPrefix {
  let i = 0;
  while (isSpace(s.charCodeAt(i))) i++;
  let negative = false;
  if (s[i] === '+' || s[i] === '-') negative = s[i++] === '-';
  const start = i;
  while (isDigit(s.charCodeAt(i))) i++;
  if (i === start) return { digits: null, negative };
  let first = start;
  while (first < i && s[first] === '0') first++;
  return { digits: s.slice(first, i), negative };
}

export type WarnFn = (message: string) => void;

/**
 * RageUtil StringToInt: `std::stoi`, base 10. Logs and returns 0 when there is no number or
 * it does not fit an int (the messages are libc++'s).
 */
export function stringToInt(s: string, warn: WarnFn): number {
  const { digits, negative } = scanInteger(s);
  if (digits === null) {
    warn(`stoi(${cString(s)}): stoi: no conversion`);
    return 0;
  }
  const magnitude = digits.length > 10 ? Infinity : Number(digits || '0');
  const value = negative ? -magnitude : magnitude;
  if (value > 2147483647 || value < -2147483648) {
    warn(`stoi(${cString(s)}): stoi: out of range`);
    return 0;
  }
  return value === 0 ? 0 : value;
}

/** C `atoi`: `(int)strtol(s, nullptr, 10)` with a 64-bit long, which saturates before it truncates. */
export function atoi(s: string): number {
  const { digits, negative } = scanInteger(s);
  if (digits === null || digits === '') return 0;
  const LONG_MAX = 9223372036854775807n;
  let value = digits.length > 19 ? LONG_MAX + 1n : BigInt(digits);
  if (negative) value = value > LONG_MAX + 1n ? -(LONG_MAX + 1n) : -value;
  else if (value > LONG_MAX) value = LONG_MAX;
  return Number(BigInt.asIntN(32, value));
}

/** printf("%f"): six decimals, exact, ties to even. */
export function formatF(x: number): string {
  if (Number.isNaN(x)) return 'nan';
  if (!Number.isFinite(x)) return x < 0 ? '-inf' : 'inf';
  const negative = x < 0 || Object.is(x, -0);
  let scaled = 0n;
  if (x !== 0) {
    const { mantissa, exponent } = decompose(Math.abs(x));
    const numerator = mantissa * 1000000n;
    if (exponent >= 0) {
      scaled = numerator << BigInt(exponent);
    } else {
      const shift = BigInt(-exponent);
      const quotient = numerator >> shift;
      const remainder = numerator - (quotient << shift);
      const half = 1n << (shift - 1n);
      const roundUp = remainder > half || (remainder === half && (quotient & 1n) === 1n);
      scaled = quotient + (roundUp ? 1n : 0n);
    }
  }
  const text = scaled.toString().padStart(7, '0');
  return `${negative ? '-' : ''}${text.slice(0, -6)}.${text.slice(-6)}`;
}
