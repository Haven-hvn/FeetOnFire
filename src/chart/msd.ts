// The MSD container format of .sm and .ssc files: `#NAME:param:param;` values.
// Port of MsdFile::ReadBuf (MsdFile.cpp), quirks included.

import { bytesToBinary } from './text.ts';

const SLASH = 0x2f;
const HASH = 0x23;
const COLON = 0x3a;
const SEMICOLON = 0x3b;
const BACKSLASH = 0x5c;
const CR = 0x0d;
const LF = 0x0a;
const SPACE = 0x20;
const TAB = 0x09;

/**
 * Splits a file into values, each a list of params (params[0] is the tag name).
 * Params are binary strings: one char per byte, no character decoding.
 *
 * Behaviour worth knowing:
 * - `//` starts a comment anywhere, also inside a value; it runs to the end of the line.
 * - A value missing its `;` ends at the next `#` that is first on its line.
 * - Text outside values is skipped (so is a byte-order mark).
 * - `\x` yields `x` literally.
 */
export function parseMsd(buf: Uint8Array, unescape = true): string[][] {
  const len = buf.length;
  const values: string[][] = [];
  const processed = new Uint8Array(len);
  let processedLen = -1;
  let readingValue = false;
  let i = 0;

  const addParam = (): void => {
    values[values.length - 1]!.push(bytesToBinary(processed, 0, processedLen));
  };

  while (i < len) {
    if (i + 1 < len && buf[i] === SLASH && buf[i + 1] === SLASH) {
      do {
        i++;
      } while (i < len && buf[i] !== LF);
      continue;
    }

    if (readingValue && buf[i] === HASH) {
      // Many files are missing a ';'. A '#' that is the first non-blank character on its
      // line ends the value.
      let firstChar = true;
      let j = processedLen;
      while (j > 0 && processed[j - 1] !== CR && processed[j - 1] !== LF) {
        if (processed[j - 1] === SPACE || processed[j - 1] === TAB) {
          --j;
          continue;
        }
        firstChar = false;
        break;
      }

      if (!firstChar) {
        processed[processedLen++] = buf[i++]!;
        continue;
      }

      processedLen = j;
      while (
        processedLen > 0 &&
        (processed[processedLen - 1] === CR ||
          processed[processedLen - 1] === LF ||
          processed[processedLen - 1] === SPACE ||
          processed[processedLen - 1] === TAB)
      ) {
        --processedLen;
      }

      addParam();
      processedLen = 0;
      readingValue = false;
    }

    if (!readingValue && buf[i] === HASH) {
      values.push([]);
      readingValue = true;
    }

    if (!readingValue) {
      if (unescape && buf[i] === BACKSLASH) i += 2;
      else ++i;
      continue;
    }

    if (processedLen !== -1 && (buf[i] === COLON || buf[i] === SEMICOLON)) addParam();

    if (buf[i] === HASH || buf[i] === COLON) {
      ++i;
      processedLen = 0;
      continue;
    }

    if (buf[i] === SEMICOLON) {
      readingValue = false;
      ++i;
      continue;
    }

    if (buf[i] === BACKSLASH) {
      if (unescape) ++i;
      else processed[processedLen++] = buf[i++]!;
    }

    if (i < len) processed[processedLen++] = buf[i++]!;
  }

  if (readingValue) addParam();
  return values;
}

/** MsdFile::value_t::operator[]: a missing param reads as an empty string. */
export function param(params: readonly string[], index: number): string {
  return index < params.length ? params[index]! : '';
}
