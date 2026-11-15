// Song timing: BPM changes, stops, delays, warps and the other segment types, and the
// conversion between beats and seconds. Port of TimingData.cpp and TimingSegments.h.
//
// Rows are integers, 48 per beat. Beats and seconds are 32-bit floats (see f32.ts): the
// arithmetic below follows the C++ expression by expression so results are bit-identical.

import { beatToNoteRow, f32, floatDiffers, FLT_MAX, INT_MAX, noteRowToBeat } from './f32.ts';

export interface BpmSegment {
  row: number;
  /** Beats per second. */
  bps: number;
}
export interface PauseSegment {
  row: number;
  seconds: number;
}
export interface RangeSegment {
  row: number;
  lengthRows: number;
}
export interface TimeSignatureSegment {
  row: number;
  numerator: number;
  denominator: number;
}
export interface TickcountSegment {
  row: number;
  ticks: number;
}
export interface ComboSegment {
  row: number;
  combo: number;
  missCombo: number;
}
export const SPEED_UNIT_BEATS = 0;
export const SPEED_UNIT_SECONDS = 1;
export interface SpeedSegment {
  row: number;
  ratio: number;
  /** How long the change takes, in beats or seconds (see unit). */
  delay: number;
  unit: number;
}
export interface ScrollSegment {
  row: number;
  ratio: number;
}
export interface LabelSegment {
  row: number;
  label: string;
}

export function bpmSegment(row: number, bpm: number): BpmSegment {
  return { row, bps: f32(bpm / 60) };
}

/** WarpSegment / FakeSegment constructed from a length in beats. */
export function rangeSegment(row: number, lengthBeats: number): RangeSegment {
  return { row, lengthRows: beatToNoteRow(lengthBeats) };
}

const EFFECT_ROW = 0;
const EFFECT_RANGE = 1;
const EFFECT_INDEFINITE = 2;

interface SegmentKind<T> {
  effect: number;
  notable(seg: T): boolean;
  equal(a: T, b: T): boolean;
}

const always = (): boolean => true;

const BPM: SegmentKind<BpmSegment> = {
  effect: EFFECT_INDEFINITE,
  notable: always,
  equal: (a, b) => !floatDiffers(a.bps, b.bps),
};
const PAUSE: SegmentKind<PauseSegment> = {
  effect: EFFECT_ROW,
  notable: (s) => s.seconds > 0,
  equal: (a, b) => !floatDiffers(a.seconds, b.seconds),
};
const RANGE: SegmentKind<RangeSegment> = {
  effect: EFFECT_RANGE,
  notable: (s) => s.lengthRows > 0,
  equal: (a, b) => a.lengthRows === b.lengthRows,
};
const TIME_SIGNATURE: SegmentKind<TimeSignatureSegment> = {
  effect: EFFECT_INDEFINITE,
  notable: always,
  equal: (a, b) => a.numerator === b.numerator && a.denominator === b.denominator,
};
const TICKCOUNT: SegmentKind<TickcountSegment> = {
  effect: EFFECT_INDEFINITE,
  notable: always,
  equal: (a, b) => a.ticks === b.ticks,
};
const COMBO: SegmentKind<ComboSegment> = {
  effect: EFFECT_INDEFINITE,
  notable: always,
  equal: (a, b) => a.combo === b.combo && a.missCombo === b.missCombo,
};
const SPEED: SegmentKind<SpeedSegment> = {
  effect: EFFECT_INDEFINITE,
  notable: always,
  equal: (a, b) => !floatDiffers(a.ratio, b.ratio) && !floatDiffers(a.delay, b.delay) && a.unit === b.unit,
};
const SCROLL: SegmentKind<ScrollSegment> = {
  effect: EFFECT_INDEFINITE,
  notable: always,
  equal: (a, b) => !floatDiffers(a.ratio, b.ratio),
};
const LABEL: SegmentKind<LabelSegment> = {
  effect: EFFECT_INDEFINITE,
  notable: always,
  equal: (a, b) => a.label === b.label,
};

/**
 * TimingData::GetSegmentIndexAtRow: the segment in effect at a row; 0 for rows before the
 * first segment; -1 for an empty list.
 */
export function segmentIndexAtRow(segs: readonly { row: number }[], row: number): number {
  if (segs.length === 0) return -1;
  const min = 0;
  const max = segs.length - 1;
  let l = min;
  let r = max;
  while (l <= r) {
    const m = (l + r) >> 1;
    if ((m === min || segs[m]!.row <= row) && (m === max || row < segs[m + 1]!.row)) return m;
    if (segs[m]!.row <= row) l = m + 1;
    else r = m - 1;
  }
  return -1;
}

/** TimingData::AddSegment: inserts a segment, dropping or merging redundant ones. */
function addSegment<T extends { row: number }>(segs: T[], seg: T, kind: SegmentKind<T>): void {
  if (segs.length === 0) {
    segs.push({ ...seg });
    return;
  }

  let index = segmentIndexAtRow(segs, seg.row);
  if (index < 0) {
    // Only when earlier adds left the list out of row order (see copy()). StepMania stops
    // here with a failed assertion, so there is no reference result: put the list in order
    // and carry on.
    segs.sort((x, y) => x.row - y.row);
    index = segmentIndexAtRow(segs, seg.row);
  }
  const cur = segs[index]!;
  const isNotable = kind.notable(seg);
  const onSameRow = seg.row === cur.row;

  // A zero-effect segment that does not overwrite anything.
  if (!isNotable && !onSameRow) return;

  if (kind.effect === EFFECT_INDEFINITE) {
    // The segment in effect before this row.
    const prev = onSameRow && index > 0 ? segs[index - 1]! : cur;
    const prevIsNotCur = prev !== cur;

    if (index < segs.length - 1) {
      const next = segs[index + 1]!;
      if (kind.equal(seg, next)) {
        // The following segment becomes redundant.
        if (kind.equal(seg, prev)) {
          segs.splice(index + 1, 1);
          if (prevIsNotCur) segs.splice(index, 1);
          return;
        }
        next.row = seg.row;
        if (prevIsNotCur) segs.splice(index, 1);
        return;
      }
      if (kind.equal(prev, seg)) {
        if (prevIsNotCur) segs.splice(index, 1);
        return;
      }
    } else if (kind.equal(prev, seg)) {
      if (prevIsNotCur) segs.splice(index, 1);
      return;
    }
  } else if (onSameRow && !isNotable) {
    // Overwriting with a zero-effect segment deletes the existing one.
    segs.splice(index, 1);
    return;
  }

  if (onSameRow && kind.equal(cur, seg)) return;

  const copy = { ...seg };
  if (onSameRow) {
    segs[index] = copy;
  } else {
    // upper_bound by row
    let lo = 0;
    let hi = segs.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (copy.row < segs[mid]!.row) hi = mid;
      else lo = mid + 1;
    }
    segs.splice(lo, 0, copy);
  }
}

const NOT_FOUND = 0;
const FOUND_WARP = 1;
const FOUND_WARP_DESTINATION = 2;
const FOUND_BPM_CHANGE = 3;
const FOUND_STOP = 4;
const FOUND_DELAY = 5;
const FOUND_STOP_DELAY = 6;
const FOUND_MARKER = 7;

/** TimingData::GetBeatStarts: where a walk over the segments has got to. */
interface WalkState {
  bpm: number;
  warp: number;
  stop: number;
  delay: number;
  lastRow: number;
  lastTime: number;
  warpDestination: number;
  isWarping: boolean;
}

interface FoundEvent {
  row: number;
  type: number;
}

/** What is happening at a point in time (TimingData::GetBeatArgs). */
export interface BeatInfo {
  beat: number;
  /** Beats per second in effect. */
  bps: number;
  /** Inside a stop. */
  freeze: boolean;
  /** Inside a delay. */
  delay: boolean;
  /** Row of the last warp passed, or -1. */
  warpBeginRow: number;
  /** Beat that warp jumps to. */
  warpDestBeat: number;
}

export type TimingWarnFn = (message: string) => void;

export class TimingData {
  /** Seconds from the start of the music to beat 0, negated (the #OFFSET value). */
  beat0OffsetSeconds: number;
  /** The file this timing came from, as a binary string; used in one warning. */
  file = '';

  bpms: BpmSegment[] = [];
  stops: PauseSegment[] = [];
  delays: PauseSegment[] = [];
  warps: RangeSegment[] = [];
  fakes: RangeSegment[] = [];
  timeSignatures: TimeSignatureSegment[] = [];
  tickcounts: TickcountSegment[] = [];
  combos: ComboSegment[] = [];
  speeds: SpeedSegment[] = [];
  scrolls: ScrollSegment[] = [];
  labels: LabelSegment[] = [];

  constructor(beat0OffsetSeconds = 0) {
    this.beat0OffsetSeconds = beat0OffsetSeconds;
  }

  addBpm(seg: BpmSegment): void {
    addSegment(this.bpms, seg, BPM);
  }
  addStop(seg: PauseSegment): void {
    addSegment(this.stops, seg, PAUSE);
  }
  addDelay(seg: PauseSegment): void {
    addSegment(this.delays, seg, PAUSE);
  }
  addWarp(seg: RangeSegment): void {
    addSegment(this.warps, seg, RANGE);
  }
  addFake(seg: RangeSegment): void {
    addSegment(this.fakes, seg, RANGE);
  }
  addTimeSignature(seg: TimeSignatureSegment): void {
    addSegment(this.timeSignatures, seg, TIME_SIGNATURE);
  }
  addTickcount(seg: TickcountSegment): void {
    addSegment(this.tickcounts, seg, TICKCOUNT);
  }
  addCombo(seg: ComboSegment): void {
    addSegment(this.combos, seg, COMBO);
  }
  addSpeed(seg: SpeedSegment): void {
    addSegment(this.speeds, seg, SPEED);
  }
  addScroll(seg: ScrollSegment): void {
    addSegment(this.scrolls, seg, SCROLL);
  }
  addLabel(seg: LabelSegment): void {
    addSegment(this.labels, seg, LABEL);
  }

  /**
   * TimingData::Copy, which C++ runs on every assignment. Not a plain copy: each segment goes
   * through the add rules again, in stored order. That matters when adding left a list out of
   * row order (a merge moves a later segment back without re-sorting): the copy is ordered.
   */
  copy(): TimingData {
    const out = new TimingData(this.beat0OffsetSeconds);
    out.file = this.file;
    for (const seg of this.bpms) out.addBpm(seg);
    for (const seg of this.stops) out.addStop(seg);
    for (const seg of this.delays) out.addDelay(seg);
    for (const seg of this.warps) out.addWarp(seg);
    for (const seg of this.fakes) out.addFake(seg);
    for (const seg of this.timeSignatures) out.addTimeSignature(seg);
    for (const seg of this.tickcounts) out.addTickcount(seg);
    for (const seg of this.combos) out.addCombo(seg);
    for (const seg of this.speeds) out.addSpeed(seg);
    for (const seg of this.scrolls) out.addScroll(seg);
    for (const seg of this.labels) out.addLabel(seg);
    return out;
  }

  /** True when there are no segments of any type. */
  empty(): boolean {
    return (
      this.bpms.length === 0 &&
      this.stops.length === 0 &&
      this.delays.length === 0 &&
      this.warps.length === 0 &&
      this.fakes.length === 0 &&
      this.timeSignatures.length === 0 &&
      this.tickcounts.length === 0 &&
      this.combos.length === 0 &&
      this.speeds.length === 0 &&
      this.scrolls.length === 0 &&
      this.labels.length === 0
    );
  }

  /**
   * TimingData::TidyUpData: makes sure every indefinite segment type has a first segment.
   * With allowEmpty, a timing without any segment is left alone (a chart that uses the song's).
   */
  tidyUp(allowEmpty: boolean, warn: TimingWarnFn): void {
    if (allowEmpty && this.empty()) return;

    if (this.bpms.length === 0) {
      warn(`Song file "${this.file}" has no BPM segments, default provided.`);
      this.addBpm(bpmSegment(0, 60));
    }
    if (this.bpms[0]!.row !== 0) this.bpms[0]!.row = 0;

    if (this.timeSignatures.length === 0) this.addTimeSignature({ row: 0, numerator: 4, denominator: 4 });
    if (this.tickcounts.length === 0) this.addTickcount({ row: 0, ticks: 4 });
    if (this.combos.length === 0) this.addCombo({ row: 0, combo: 1, missCombo: 1 });
    if (this.labels.length === 0) this.addLabel({ row: 0, label: 'Song Start' });
    if (this.speeds.length === 0) this.addSpeed({ row: 0, ratio: 1, delay: 0, unit: SPEED_UNIT_BEATS });
    if (this.scrolls.length === 0) this.addScroll({ row: 0, ratio: 1 });
  }

  /** Beats per minute in effect at a row. Needs at least one BPM segment (see tidyUp). */
  bpmAtRow(row: number): number {
    if (this.bpms.length === 0) throw new Error('TimingData has no BPM segments; call tidyUp() first');
    // The lookup can fail on a list that is out of row order (see copy()); StepMania then
    // reads outside the list. The first segment is used instead.
    const index = Math.max(0, segmentIndexAtRow(this.bpms, row));
    return f32(this.bpms[index]!.bps * 60);
  }

  /** Length of the stop exactly on this row, else 0. */
  stopAtRow(row: number): number {
    const index = segmentIndexAtRow(this.stops, row);
    return index >= 0 && this.stops[index]!.row === row ? this.stops[index]!.seconds : 0;
  }

  /** Length of the delay exactly on this row, else 0. */
  delayAtRow(row: number): number {
    const index = segmentIndexAtRow(this.delays, row);
    return index >= 0 && this.delays[index]!.row === row ? this.delays[index]!.seconds : 0;
  }

  private inRange(segs: readonly RangeSegment[], row: number): boolean {
    const index = segmentIndexAtRow(segs, row);
    if (index < 0) return false;
    const s = segs[index]!;
    const beat = noteRowToBeat(row);
    const start = noteRowToBeat(s.row);
    return start <= beat && beat < f32(start + noteRowToBeat(s.lengthRows));
  }

  /** Inside a warp: notes here are skipped over and cannot be hit. */
  isWarpAtRow(row: number): boolean {
    if (this.warps.length === 0) return false;
    if (!this.inRange(this.warps, row)) return false;
    if (this.stops.length === 0 && this.delays.length === 0) return true;
    // A stop or delay inside a warp makes that row hittable.
    if (this.stopAtRow(row) !== 0 || this.delayAtRow(row) !== 0) return false;
    return true;
  }

  /** Inside a fake section: notes here are shown but not judged. */
  isFakeAtRow(row: number): boolean {
    if (this.fakes.length === 0) return false;
    return this.inRange(this.fakes, row);
  }

  isJudgableAtRow(row: number): boolean {
    return !this.isWarpAtRow(row) && !this.isFakeAtRow(row);
  }

  // Scratch for the walks below, so that a lookup does not allocate (the game calls these
  // every frame). The lookups do not call each other while a walk is under way.
  private readonly walk: WalkState = { bpm: 0, warp: 0, stop: 0, delay: 0, lastRow: 0, lastTime: 0, warpDestination: 0, isWarping: false };
  private readonly found: FoundEvent = { row: INT_MAX, type: NOT_FOUND };

  private newWalk(): WalkState {
    const walk = this.walk;
    walk.bpm = 0;
    walk.warp = 0;
    walk.stop = 0;
    walk.delay = 0;
    walk.lastRow = 0;
    walk.lastTime = f32(-this.beat0OffsetSeconds);
    walk.warpDestination = 0;
    walk.isWarping = false;
    return walk;
  }

  /** TimingData.cpp FindEvent: the next thing on the timeline, in this fixed priority order. */
  private findEvent(ev: FoundEvent, start: WalkState, beat: number, findMarker: boolean): void {
    if (start.isWarping && beatToNoteRow(start.warpDestination) < ev.row) {
      ev.row = beatToNoteRow(start.warpDestination);
      ev.type = FOUND_WARP_DESTINATION;
    }
    if (start.bpm < this.bpms.length && this.bpms[start.bpm]!.row < ev.row) {
      ev.row = this.bpms[start.bpm]!.row;
      ev.type = FOUND_BPM_CHANGE;
    }
    if (start.delay < this.delays.length && this.delays[start.delay]!.row < ev.row) {
      ev.row = this.delays[start.delay]!.row;
      ev.type = FOUND_DELAY;
    }
    if (findMarker && beatToNoteRow(beat) < ev.row) {
      ev.row = beatToNoteRow(beat);
      ev.type = FOUND_MARKER;
    }
    if (start.stop < this.stops.length && this.stops[start.stop]!.row < ev.row) {
      const previousRow = ev.row;
      ev.row = this.stops[start.stop]!.row;
      // As in the original: the rows can never be equal here, so this is always FOUND_STOP.
      ev.type = previousRow === ev.row ? FOUND_STOP_DELAY : FOUND_STOP;
    }
    if (start.warp < this.warps.length && this.warps[start.warp]!.row < ev.row) {
      ev.row = this.warps[start.warp]!.row;
      ev.type = FOUND_WARP;
    }
  }

  /**
   * Beat (and what is in effect) at a time in seconds from the start of the music.
   * TimingData::GetBeatAndBPSFromElapsedTimeNoOffset: no global offset applied.
   */
  beatInfoAtSeconds(
    seconds: number,
    out: BeatInfo = { beat: 0, bps: 0, freeze: false, delay: false, warpBeginRow: -1, warpDestBeat: 0 },
  ): BeatInfo {
    let elapsed = seconds;
    out.beat = 0;
    out.bps = 0;
    out.freeze = false;
    out.delay = false;
    out.warpBeginRow = -1;
    out.warpDestBeat = 0;
    const start = this.newWalk();
    let bps = f32(this.bpmAtRow(start.lastRow) / 60);
    const ev = this.found;

    for (;;) {
      ev.row = INT_MAX;
      ev.type = NOT_FOUND;
      this.findEvent(ev, start, 0, false);
      if (ev.type === NOT_FOUND) break;
      const timeToNext = start.isWarping ? 0 : f32(noteRowToBeat((ev.row - start.lastRow) | 0) / bps);
      let nextEventTime = f32(start.lastTime + timeToNext);
      if (elapsed < nextEventTime) break;
      start.lastTime = nextEventTime;

      let type = ev.type;
      if (type === FOUND_WARP_DESTINATION) {
        start.isWarping = false;
      } else if (type === FOUND_BPM_CHANGE) {
        bps = this.bpms[start.bpm]!.bps;
        ++start.bpm;
      } else if (type === FOUND_WARP) {
        start.isWarping = true;
        const ws = this.warps[start.warp]!;
        const warpSum = f32(noteRowToBeat(ws.lengthRows) + noteRowToBeat(ws.row));
        if (warpSum > start.warpDestination) start.warpDestination = warpSum;
        out.warpBeginRow = ev.row;
        out.warpDestBeat = start.warpDestination;
        ++start.warp;
      } else {
        if (type === FOUND_DELAY || type === FOUND_STOP_DELAY) {
          const delay = this.delays[start.delay]!;
          nextEventTime = f32(start.lastTime + delay.seconds);
          if (elapsed < nextEventTime) {
            out.freeze = false;
            out.delay = true;
            out.beat = noteRowToBeat(delay.row);
            out.bps = bps;
            return out;
          }
          start.lastTime = nextEventTime;
          ++start.delay;
          if (type === FOUND_STOP_DELAY) type = FOUND_STOP; // falls through to the stop
        }
        if (type === FOUND_STOP) {
          const stop = this.stops[start.stop]!;
          nextEventTime = f32(start.lastTime + stop.seconds);
          if (elapsed < nextEventTime) {
            out.freeze = true;
            out.delay = false;
            out.beat = noteRowToBeat(stop.row);
            out.bps = bps;
            return out;
          }
          start.lastTime = nextEventTime;
          ++start.stop;
        }
      }
      start.lastRow = ev.row;
    }

    if (elapsed === FLT_MAX) elapsed = start.lastTime;
    out.beat = f32(noteRowToBeat(start.lastRow) + f32(f32(elapsed - start.lastTime) * bps));
    out.bps = bps;
    return out;
  }

  private readonly info: BeatInfo = { beat: 0, bps: 0, freeze: false, delay: false, warpBeginRow: -1, warpDestBeat: 0 };

  /** Beat at a time in seconds from the start of the music. */
  beatAtSeconds(seconds: number): number {
    return this.beatInfoAtSeconds(seconds, this.info).beat;
  }

  /**
   * Seconds from the start of the music at which a beat is reached.
   * TimingData::GetElapsedTimeFromBeatNoOffset: no global offset applied.
   *
   * A delay on the beat's own row is included (the note comes after the delay); a stop on
   * that row is not (the note comes before the stop).
   */
  secondsAtBeat(beat: number): number {
    const start = this.newWalk();
    let bps = f32(this.bpmAtRow(start.lastRow) / 60);
    const findMarker = beat < FLT_MAX;
    const ev = this.found;

    for (;;) {
      ev.row = INT_MAX;
      ev.type = NOT_FOUND;
      this.findEvent(ev, start, beat, findMarker);
      // The original has no exit here; it can only be reached with a beat of FLT_MAX or NaN.
      if (ev.type === NOT_FOUND) return start.lastTime;
      const timeToNext = start.isWarping ? 0 : f32(noteRowToBeat((ev.row - start.lastRow) | 0) / bps);
      start.lastTime = f32(start.lastTime + timeToNext);
      switch (ev.type) {
        case FOUND_WARP_DESTINATION:
          start.isWarping = false;
          break;
        case FOUND_BPM_CHANGE:
          bps = this.bpms[start.bpm]!.bps;
          ++start.bpm;
          break;
        case FOUND_STOP:
        case FOUND_STOP_DELAY:
          start.lastTime = f32(start.lastTime + this.stops[start.stop]!.seconds);
          ++start.stop;
          break;
        case FOUND_DELAY:
          start.lastTime = f32(start.lastTime + this.delays[start.delay]!.seconds);
          ++start.delay;
          break;
        case FOUND_MARKER:
          return start.lastTime;
        case FOUND_WARP: {
          start.isWarping = true;
          const ws = this.warps[start.warp]!;
          const warpSum = f32(noteRowToBeat(ws.lengthRows) + noteRowToBeat(ws.row));
          if (warpSum > start.warpDestination) start.warpDestination = warpSum;
          ++start.warp;
          break;
        }
      }
      start.lastRow = ev.row;
    }
  }

  /** Seconds at a row. */
  secondsAtRow(row: number): number {
    return this.secondsAtBeat(noteRowToBeat(row));
  }

  /** TimingData::GetDisplayedBeat: the beat after scroll segments, for drawing. */
  displayedBeat(beat: number): number {
    const scrolls = this.scrolls;
    if (scrolls.length === 0) return beat; // the original reads out of bounds; tidyUp() prevents it
    let out = 0;
    let i = 0;
    for (; i < scrolls.length - 1; i++) {
      const nextBeat = noteRowToBeat(scrolls[i + 1]!.row);
      if (nextBeat > beat) break;
      out = f32(out + f32(f32(nextBeat - noteRowToBeat(scrolls[i]!.row)) * scrolls[i]!.ratio));
    }
    return f32(out + f32(f32(beat - noteRowToBeat(scrolls[i]!.row)) * scrolls[i]!.ratio));
  }

  /**
   * TimingData::GetDisplayedSpeedPercent: the scroll speed multiplier from speed segments,
   * at a beat and the matching time. Global offset 0 and music rate 1 are assumed.
   */
  displayedSpeedPercent(songBeat: number, musicSeconds: number): number {
    const speeds = this.speeds;
    if (speeds.length === 0) return 1;

    const index = Math.max(0, segmentIndexAtRow(speeds, beatToNoteRow(songBeat)));
    const seg = speeds[index]!;
    const startBeat = noteRowToBeat(seg.row);
    const startTime = f32(this.secondsAtBeat(startBeat) - this.delayAtRow(beatToNoteRow(startBeat)));
    const curTime = musicSeconds;
    let endTime: number;
    if (seg.unit === SPEED_UNIT_SECONDS) {
      endTime = f32(startTime + seg.delay);
    } else {
      const endBeat = f32(startBeat + seg.delay);
      endTime = f32(this.secondsAtBeat(endBeat) - this.delayAtRow(beatToNoteRow(endBeat)));
    }

    const first = speeds[0]!;
    if (index === 0 && first.delay > 0 && curTime < startTime) return 1;
    if (endTime >= curTime && (index > 0 || first.delay > 0)) {
      const priorSpeed = index === 0 ? 1 : speeds[index - 1]!.ratio;
      const timeUsed = f32(curTime - startTime);
      const duration = f32(endTime - startTime);
      const ratioUsed = duration === 0 ? 1 : f32(timeUsed / duration);
      const distance = f32(priorSpeed - seg.ratio);
      const ratioNeed = f32(ratioUsed * -distance);
      return f32(priorSpeed + ratioNeed);
    }
    return seg.ratio;
  }
}
