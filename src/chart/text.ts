// String helpers from RageUtil and StdString, on "binary strings" (one char per file byte).

import { f32 } from './f32.ts';
import { stringToFloat, stringToInt, type WarnFn } from './cnum.ts';

/** Bytes to a binary string: char code = byte value. */
export function bytesToBinary(bytes: Uint8Array, start = 0, end = bytes.length): string {
  let out = '';
  for (let i = start; i < end; i += 8192) {
    out += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(end, i + 8192)) as unknown as number[]);
  }
  return out;
}

/** A JavaScript string to a binary string holding its UTF-8 bytes. */
export function utf8ToBinary(text: string): string {
  return bytesToBinary(new TextEncoder().encode(text));
}

const utf8Decoder = new TextDecoder('utf-8', { ignoreBOM: true });

/** A binary string read as UTF-8 (invalid bytes become U+FFFD). For text shown to people. */
export function binaryToUtf8(s: string): string {
  let ascii = true;
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) >= 0x80) {
      ascii = false;
      break;
    }
  }
  if (ascii) return s;
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
  return utf8Decoder.decode(bytes);
}

/** The default trim set. RageUtil uses strchr, which also matches the terminating NUL. */
const WHITESPACE = '\r\n\t ';

function inSet(set: string, ch: string): boolean {
  return ch === '\0' || set.includes(ch);
}

export function trimLeft(s: string, set = WHITESPACE): string {
  let n = 0;
  while (n < s.length && inSet(set, s[n]!)) n++;
  return s.slice(n);
}

export function trimRight(s: string, set = WHITESPACE): string {
  let n = s.length;
  while (n > 0 && inSet(set, s[n - 1]!)) n--;
  return s.slice(0, n);
}

export function trim(s: string, set = WHITESPACE): string {
  return trimLeft(trimRight(s, set), set);
}

/** RageUtil split(): pieces between delimiters; an empty source gives no pieces. */
export function split(source: string, delimiter: string, ignoreEmpty = true): string[] {
  const out: string[] = [];
  if (source === '') return out;
  let start = 0;
  do {
    let pos = source.indexOf(delimiter, start);
    if (pos < 0) pos = source.length;
    if (pos - start > 0 || !ignoreEmpty) out.push(source.slice(start, pos));
    start = pos + delimiter.length;
  } while (start <= source.length);
  return out;
}

export interface SplitCursor {
  begin: number;
  size: number;
}

/**
 * RageUtil's in-place split (do_split with begin/size): advances the cursor to the next piece
 * of source[0..len). Start with size -1; finished when begin === len.
 */
export function splitNext(source: string, delimiter: string, cursor: SplitCursor, len: number, ignoreEmpty: boolean): void {
  if (cursor.size !== -1) {
    cursor.begin += cursor.size + delimiter.length;
    cursor.begin = Math.min(cursor.begin, len);
  }
  cursor.size = 0;
  if (ignoreEmpty) {
    while (cursor.begin + delimiter.length < source.length && source.startsWith(delimiter, cursor.begin)) cursor.begin++;
  }
  let pos = source.indexOf(delimiter, cursor.begin);
  if (pos < 0 || pos > len) pos = len;
  cursor.size = pos - cursor.begin;
}

/** RString::MakeUpper for ASCII. (The original also maps non-ASCII UTF-8 letters.) */
export function makeUpper(s: string): string {
  return s.replace(/[a-z]+/g, (m) => m.toUpperCase());
}

/** RString::MakeLower for ASCII. */
export function makeLower(s: string): string {
  return s.replace(/[A-Z]+/g, (m) => m.toLowerCase());
}

/** RString::EqualsNoCase / CompareNoCase == 0: ASCII case-insensitive, on C strings (to the first NUL). */
export function equalsNoCase(a: string, b: string): boolean {
  const cut = (s: string): string => {
    const end = s.indexOf('\0');
    return end < 0 ? s : s.slice(0, end);
  };
  return makeLower(cut(a)) === makeLower(cut(b));
}

/** RageUtil HHMMSSToSeconds. */
export function hhmmssToSeconds(s: string, warn: WarnFn): number {
  const bits = split(s, ':', false);
  while (bits.length < 3) bits.unshift('0');
  let seconds = 0;
  // int arithmetic; overflow is undefined in C++, here it wraps.
  seconds = f32(seconds + f32(Math.imul(Math.imul(stringToInt(bits[0]!, warn), 60), 60)));
  seconds = f32(seconds + f32(Math.imul(stringToInt(bits[1]!, warn), 60)));
  seconds = f32(seconds + stringToFloat(bits[2]!));
  return seconds;
}
