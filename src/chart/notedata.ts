// Note data: the rows-and-tracks grid of a chart, and the parser for the `#NOTES` text.
// Port of NoteData.cpp and NoteDataUtil::LoadFromSMNoteDataString.

import { cString, formatF } from './cnum.ts';
import { BEATS_PER_MEASURE, beatToNoteRow, f32, MAX_NOTE_ROW, noteRowToBeat } from './f32.ts';
import { splitNext, type SplitCursor } from './text.ts';

export type TapNoteType = 'Tap' | 'HoldHead' | 'Mine' | 'Lift' | 'AutoKeySound' | 'Fake';
export type HoldSubType = 'Hold' | 'Roll';

export interface TapNote {
  type: TapNoteType;
  /** Set for HoldHead. */
  subType: HoldSubType | null;
  /** Hold length in rows; 0 for everything else. */
  durationRows: number;
}

export interface Note extends TapNote {
  row: number;
  track: number;
}

/** One track: notes by row, with the rows kept sorted. */
class Track {
  readonly rows: number[] = [];
  readonly notes = new Map<number, TapNote>();

  /** Index of the first row >= the given row. */
  lowerBound(row: number): number {
    const rows = this.rows;
    let lo = 0;
    let hi = rows.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (rows[mid]! < row) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  set(row: number, note: TapNote): void {
    if (!this.notes.has(row)) {
      const rows = this.rows;
      if (rows.length === 0 || rows[rows.length - 1]! < row) rows.push(row);
      else rows.splice(this.lowerBound(row), 0, row);
    }
    this.notes.set(row, note);
  }

  remove(row: number): void {
    if (!this.notes.delete(row)) return;
    this.rows.splice(this.lowerBound(row), 1);
  }
}

export class NoteData {
  private readonly tracks: Track[] = [];

  constructor(numTracks = 0) {
    for (let t = 0; t < numTracks; t++) this.tracks.push(new Track());
  }

  get numTracks(): number {
    return this.tracks.length;
  }

  getTapNote(track: number, row: number): TapNote | undefined {
    return this.tracks[track]!.notes.get(row);
  }

  /** NoteData::SetTapNote for a non-empty note: negative rows are ignored. */
  setTapNote(track: number, row: number, note: TapNote): void {
    if (row < 0) return;
    this.tracks[track]!.set(row, note);
  }

  removeTapNote(track: number, row: number): void {
    this.tracks[track]!.remove(row);
  }

  /**
   * NoteData::IsHoldNoteAtRow: the head row of a hold covering this row, else -1.
   * Only rows before `row` are looked at: a head on `row` itself does not count.
   */
  holdHeadRowAt(track: number, row: number): number {
    const t = this.tracks[track]!;
    for (let i = t.lowerBound(row) - 1; i >= 0; i--) {
      const r = t.rows[i]!;
      const tn = t.notes.get(r)!;
      switch (tn.type) {
        case 'HoldHead':
          return tn.durationRows + r < row ? -1 : r;
        case 'Tap':
        case 'Mine':
        case 'Lift':
        case 'Fake':
          return -1;
        case 'AutoKeySound':
          break;
      }
    }
    return -1;
  }

  /** NoteData::GetFirstRow: the earliest row with a note that is not an auto keysound; 0 if none. */
  firstRow(): number {
    let earliest = MAX_NOTE_ROW;
    for (const t of this.tracks) {
      for (const r of t.rows) {
        if (t.notes.get(r)!.type === 'AutoKeySound') continue;
        if (r < earliest) earliest = r;
        break;
      }
    }
    return earliest < MAX_NOTE_ROW ? earliest : 0;
  }

  /** NoteData::GetLastRow: the last row with a note, hold tails included; 0 if none. */
  lastRow(): number {
    let oldest = 0;
    for (const t of this.tracks) {
      if (t.rows.length === 0) continue;
      let r = t.rows[t.rows.length - 1]!;
      const tn = t.notes.get(r)!;
      if (tn.type === 'HoldHead') r += tn.durationRows;
      if (r > oldest) oldest = r;
    }
    return oldest;
  }

  /** All notes, by row and then track. */
  notes(): Note[] {
    const out: Note[] = [];
    this.tracks.forEach((t, track) => {
      for (const row of t.rows) out.push({ row, track, ...t.notes.get(row)! });
    });
    out.sort((a, b) => a.row - b.row || a.track - b.track);
    return out;
  }

  /** Rows of one track, ascending. */
  trackRows(track: number): readonly number[] {
    return this.tracks[track]!.rows;
  }
}

const WHITESPACE = '\r\n\t ';

/**
 * NoteDataUtil::LoadFromSMNoteDataString for one player: measures separated by ',', one line
 * per row, one character per track.
 *
 *   0 empty   1 tap   2 hold head   4 roll head   3 hold/roll tail
 *   M mine    K auto keysound   L lift   F fake   anything else: empty
 *
 * A `[n]` after a note is a keysound index and is skipped. Each line of a measure with n
 * lines is 1/n of the measure further on.
 */
export function loadNoteDataString(text: string, numTracks: number, warn: (message: string) => void): NoteData {
  const out = new NoteData(numTracks);

  // Strip `//` comments. (MsdFile has normally removed them already.)
  let s = text;
  if (s.includes('//')) {
    let stripped = '';
    let commentEnd = 0;
    for (;;) {
      const commentStart = s.indexOf('//', commentEnd);
      if (commentStart < 0) {
        stripped += s.slice(commentEnd);
        break;
      }
      stripped += s.slice(commentEnd, commentStart);
      const newline = s.indexOf('\n', commentStart);
      if (newline < 0) break;
      commentEnd = newline + 1;
    }
    s = stripped;
  }

  const end = s.length;
  const measure: SplitCursor = { begin: 0, size: -1 };
  const lines: [number, number][] = [];
  for (let m = 0; ; m++) {
    // Empty measures are skipped: ",,," counts as one separator.
    splitNext(s, ',', measure, end, true);
    if (measure.begin === end) break;

    const line: SplitCursor = { begin: measure.begin, size: -1 };
    const measureEnd = measure.begin + measure.size;
    lines.length = 0;
    for (;;) {
      splitNext(s, '\n', line, measureEnd, true);
      if (line.begin === measureEnd) break;
      let beginLine = line.begin;
      let endLine = beginLine + line.size;
      while (beginLine < endLine && WHITESPACE.includes(s[beginLine]!)) ++beginLine;
      while (endLine > beginLine && WHITESPACE.includes(s[endLine - 1]!)) --endLine;
      if (beginLine < endLine) lines.push([beginLine, endLine]);
    }

    for (let l = 0; l < lines.length; l++) {
      const [beginLine, endLine] = lines[l]!;
      let p = beginLine;
      const percentIntoMeasure = f32(l / lines.length);
      const beat = f32(f32(f32(m) + percentIntoMeasure) * BEATS_PER_MEASURE);
      const row = beatToNoteRow(beat);

      let track = 0;
      while (track < numTracks && p < endLine) {
        const ch = s[p]!;
        let tn: TapNote | null = null;
        switch (ch) {
          case '1':
            tn = { type: 'Tap', subType: null, durationRows: 0 };
            break;
          case '2':
          case '4':
            // Open-ended until the tail is found.
            tn = { type: 'HoldHead', subType: ch === '2' ? 'Hold' : 'Roll', durationRows: MAX_NOTE_ROW };
            break;
          case '3': {
            const headRow = out.holdHeadRowAt(track, row);
            if (headRow < 0) warn(`Unmatched 3 in "${cString(s.slice(beginLine, endLine))}"`);
            else out.getTapNote(track, headRow)!.durationRows = row - headRow;
            break;
          }
          case 'M':
            tn = { type: 'Mine', subType: null, durationRows: 0 };
            break;
          case 'K':
            tn = { type: 'AutoKeySound', subType: null, durationRows: 0 };
            break;
          case 'L':
            tn = { type: 'Lift', subType: null, durationRows: 0 };
            break;
          case 'F':
            tn = { type: 'Fake', subType: null, durationRows: 0 };
            break;
          default:
            break;
        }

        p++;
        // Optional keysound index, e.g. "[123]": skipped.
        if (p < endLine && s[p] === '[') {
          p++;
          while (p < endLine) {
            if (s[p++] === ']') break;
          }
        }

        if (tn !== null) out.setTapNote(track, row, tn);
        track++;
      }
    }
  }

  // Holds that never found a tail are dropped.
  for (let t = 0; t < numTracks; t++) {
    for (const row of [...out.trackRows(t)]) {
      const tn = out.getTapNote(t, row)!;
      if (tn.type === 'HoldHead' && tn.durationRows === MAX_NOTE_ROW) {
        warn(`While loading .sm/.ssc note data, there was an unmatched 2 at beat ${formatF(noteRowToBeat(row))}`);
        out.removeTapNote(t, row);
      }
    }
  }

  return out;
}
