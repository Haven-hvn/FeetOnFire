// Where notes are on the note field: scroll position, layout and note colours. Port of the
// parts of ArrowEffects.cpp and the `_fallback` [Player] metrics the v1 options need (speed
// mods x, C and M; reverse). Pure: no browser dependencies.
//
// Lengths are StepMania's logical pixels: the screen is 480 high, an arrow 64 across.

import { DISPLAY_BPM_SPECIFIED, noteRowToBeat, type BeatInfo, type Chart, type TimingData } from '../chart/index.ts';

const f32 = Math.fround;

export const SCREEN_HEIGHT = 480;
/** [ArrowEffects] ArrowSpacing: pixels per beat at 1x. */
export const ARROW_SPACING = 64;
export const ARROW_SIZE = 64;
/** [Player] ReceptorArrowsYStandard / Reverse, from the centre of the field. */
export const RECEPTOR_Y_STANDARD = -144;
export const RECEPTOR_Y_REVERSE = 144;
/** [Player] DrawDistanceBeforeTargetsPixels / AfterTargetsPixels. */
export const DRAW_DISTANCE_BEFORE = SCREEN_HEIGHT;
export const DRAW_DISTANCE_AFTER = -128;
/** [Player] MModHighCap. */
export const M_MOD_HIGH_CAP = 600;

export type SpeedMode = 'x' | 'c' | 'm';

export interface ScrollOptions {
  /** x: multiple of the song's tempo; c: constant BPM; m: x-mod scaled so the fastest part scrolls at this BPM. */
  mode: SpeedMode;
  value: number;
  reverse: boolean;
}

export const DEFAULT_SCROLL: ScrollOptions = { mode: 'x', value: 1, reverse: false };

/** Reads "2x", "1.5x", "C450", "m600" and the like; null when it is none of them. */
export function parseSpeed(text: string): { mode: SpeedMode; value: number } | null {
  const s = text.trim().toLowerCase();
  let match = /^(\d+(?:\.\d+)?)x$/.exec(s);
  if (match) return { mode: 'x', value: Number(match[1]) };
  match = /^([cm])(\d+(?:\.\d+)?)$/.exec(s);
  if (match && Number(match[2]) > 0) return { mode: match[1] as SpeedMode, value: Number(match[2]) };
  return null;
}

/** TimingData::GetActualBPM: the highest tempo of the chart, not above `cap`. */
function actualMaxBpm(timing: TimingData, cap: number): number {
  let max = 0;
  for (const segment of timing.bpms) max = Math.min(Math.max(f32(segment.bps * 60), max), cap);
  return max;
}

/**
 * The tempo an M-mod is measured against (Player::Init, m_fReadBPM): the chart's displayed
 * maximum when one is given, else its real one; never above MModHighCap.
 */
export function readBpm(chart: Pick<Chart, 'displayBpmType' | 'displayBpmMin' | 'displayBpmMax' | 'timing'>): number {
  // A random ("secret") or absent display tempo gives 0 here, and the real one is used.
  let max = 0;
  if (chart.displayBpmType === DISPLAY_BPM_SPECIFIED) {
    max = Math.min(Math.max(0, chart.displayBpmMin, chart.displayBpmMax), M_MOD_HIGH_CAP);
  }
  if (max === 0) max = actualMaxBpm(chart.timing, M_MOD_HIGH_CAP);
  return max > 0 ? max : 60;
}

/** NoteTypes.cpp GetNoteType: 0 = 4th, 1 = 8th, 2 = 12th, 3 = 16th, 4 = 24th, 5 = 32nd, 6 = 48th, 7 = 64th, 8 = 192nd. */
export function quantisation(row: number): number {
  if (row % 48 === 0) return 0;
  if (row % 24 === 0) return 1;
  if (row % 16 === 0) return 2;
  if (row % 12 === 0) return 3;
  if (row % 8 === 0) return 4;
  if (row % 6 === 0) return 5;
  if (row % 4 === 0) return 6;
  if (row % 3 === 0) return 7;
  return 8;
}

/** X of a column's centre from the centre of the field. */
export function columnX(track: number, numTracks: number): number {
  return (track - (numTracks - 1) / 2) * ARROW_SIZE;
}

/**
 * ArrowEffects::GetYOffset without the effect mods: how far below its receptor (in pixels,
 * before reverse) a note is at the current music time. Call update() once per frame, then
 * yOffset() per note.
 */
export class Scroller {
  readonly options: ScrollOptions;
  private readonly timing: TimingData;
  private readonly scrollSpeed: number;
  private readonly info: BeatInfo = { beat: 0, bps: 0, freeze: false, delay: false, warpBeginRow: -1, warpDestBeat: 0 };
  /** Set by update(). */
  songSeconds = 0;
  songBeat = 0;
  private songDisplayBeat = 0;
  private speedPercent = 1;

  constructor(timing: TimingData, options: ScrollOptions, readBpmValue: number) {
    this.timing = timing;
    this.options = options;
    this.scrollSpeed = options.mode === 'x' ? options.value : options.mode === 'm' ? options.value / readBpmValue : 1;
  }

  update(musicSeconds: number): void {
    this.songSeconds = musicSeconds;
    const timing = this.timing;
    this.songBeat = timing.beatInfoAtSeconds(f32(musicSeconds), this.info).beat;
    if (this.options.mode !== 'c') {
      this.songDisplayBeat = timing.displayedBeat(this.songBeat);
      this.speedPercent = timing.displayedSpeedPercent(this.songBeat, f32(musicSeconds));
    }
  }

  /** The beat as scroll segments show it: compute once per note and pass to yOffset(). */
  displayBeatOfRow(row: number): number {
    return this.timing.displayedBeat(noteRowToBeat(row));
  }

  /** Display beat of a moment in the song (for a hold let go at that time). */
  displayBeatAtSeconds(seconds: number): number {
    return this.timing.displayedBeat(this.timing.beatInfoAtSeconds(f32(seconds), this.info).beat);
  }

  /** Pixels from the receptor: positive is still to come. */
  yOffset(displayBeat: number, seconds: number): number {
    if (this.options.mode === 'c') return (seconds - this.songSeconds) * (this.options.value / 60) * ARROW_SPACING;
    return (displayBeat - this.songDisplayBeat) * this.speedPercent * ARROW_SPACING * this.scrollSpeed;
  }

  /** Y of the receptors from the centre of the field. */
  get receptorY(): number {
    return this.options.reverse ? RECEPTOR_Y_REVERSE : RECEPTOR_Y_STANDARD;
  }

  /** ArrowEffects::GetYPos: field Y of something `offset` pixels from the receptor. */
  yPos(offset: number): number {
    return this.options.reverse ? RECEPTOR_Y_REVERSE - offset : RECEPTOR_Y_STANDARD + offset;
  }
}
