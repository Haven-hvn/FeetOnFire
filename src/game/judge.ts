// Judging: turns press and release times into tap, hold and mine judgements, and feeds the
// score keeper and the life meter. Port of the judging parts of Player.cpp for the `dance`
// game with default preferences (docs/HANDOVER.md section 6). Pure: no browser dependencies.
//
// Where StepMania works frame by frame, this works by time: every input carries its own
// music time, and everything the clock alone decides (a miss, a mine passing under a held
// panel, a hold running out or reaching its end) happens at a time computed from the chart.
// advance() applies those in time order, so the result does not depend on the frame rate or
// on how often advance() is called. The rules themselves are the original's:
//
//   - A press is judged against the closest unjudged note of its column by row (a tie goes
//     to the later note), within one second either way. Mines and fake-type notes take part.
//   - A note not hit is a Miss 0.5 s (the largest window) after the song has passed its
//     row; with rounded rows, as in the original, that is half a row past the note.
//   - A row is scored once, when its last note is judged, with the score of the last note
//     hit, or Miss if any note was missed.
//   - A hold is let go when the panel has been up for 0.25 s between the head being judged
//     (or crossed, if that is later) and the hold's end; a roll when 0.5 s pass without a
//     press. The end is reached when the rounded song row reaches the end row.
//   - Holding a panel while a mine crosses hits the mine.
//
// Not carried over (off by default in the original): MinTNSToScoreNotes and the early-hit
// re-judging that goes with it, hold checkpoints, attacks, keysounds.

import { beatToNoteRow, ROWS_PER_BEAT, type TimedNote, type TimingData } from '../chart/index.ts';
import { segmentIndexAtRow } from '../chart/timing.ts';
import { HNS, MAX_STEP_DISTANCE_SECONDS, MIN_TNS_TO_HIDE_NOTES, STEP_SEARCH_SECONDS, TNS, WINDOW } from './constants.ts';
import { LifeMeter } from './life.ts';
import { ScoreKeeper, type ChartTotals } from './score.ts';

export const NOTE_TAP = 0;
export const NOTE_HOLD_HEAD = 1;
export const NOTE_MINE = 2;
export const NOTE_LIFT = 3;
export const NOTE_AUTO_KEYSOUND = 4;
export const NOTE_FAKE = 5;

const TYPE_CODE: Record<TimedNote['type'], number> = {
  Tap: NOTE_TAP,
  HoldHead: NOTE_HOLD_HEAD,
  Mine: NOTE_MINE,
  Lift: NOTE_LIFT,
  AutoKeySound: NOTE_AUTO_KEYSOUND,
  Fake: NOTE_FAKE,
};

/** A row was judged. track: first track with a tap; value: TNS; offset: seconds, negative early. */
export const EV_TAP_JUDGMENT = 1;
/** A hold or roll was judged. value: HNS. */
export const EV_HOLD_JUDGMENT = 2;
/** A mine was hit. */
export const EV_MINE_HIT = 3;
/** A note of a row completed by a step: flash the receptor. value: the row's TNS. */
export const EV_GHOST = 4;
/** The life bar ran out. */
export const EV_FAILED = 5;

export type JudgeEventFn = (kind: number, seconds: number, track: number, value: number, offset: number, note: number) => void;

export interface JudgeOptions {
  /** Every note is hit exactly on time and every hold held (PlayerController autoplay). */
  autoplay?: boolean;
  /** 'immediate' (the default): running out of life fails the player; 'off': never fails. */
  failType?: 'immediate' | 'off';
}

const RESULT_HELD = HNS.Held;
const RESULT_LET_GO = HNS.LetGo;
const RESULT_MISSED = HNS.Missed;

/** Counts what a chart can score (NoteDataUtil::CalculateRadarValues): judgable rows only. */
export function chartTotals(notes: readonly TimedNote[]): ChartTotals {
  const totals: ChartTotals = { tapsAndHolds: 0, holds: 0, rolls: 0 };
  let lastRow = -1;
  for (const note of notes) {
    if (!note.judgable) continue;
    if (note.type !== 'Tap' && note.type !== 'HoldHead' && note.type !== 'Lift') continue;
    if (note.row !== lastRow) {
      lastRow = note.row;
      totals.tapsAndHolds++;
    }
    if (note.type === 'HoldHead') {
      if (note.subType === 'Roll') totals.rolls++;
      else totals.holds++;
    }
  }
  return totals;
}

export class Judge {
  readonly count: number;
  readonly numTracks: number;
  readonly autoplay: boolean;
  readonly keeper: ScoreKeeper;
  readonly life = new LifeMeter();
  onEvent: JudgeEventFn | null = null;

  // The chart, one entry per note, by row and then track.
  readonly row: Int32Array;
  readonly endRow: Int32Array;
  readonly track: Uint8Array;
  readonly type: Uint8Array;
  readonly roll: Uint8Array;
  readonly judgable: Uint8Array;
  /** When the note is to be hit. */
  readonly seconds: Float64Array;
  /** When a hold ends on the chart (for drawing). */
  readonly endSeconds: Float64Array;

  // Results.
  readonly tns: Uint8Array;
  /** Seconds from the note to the step that hit it; negative is early. */
  readonly offset: Float64Array;
  readonly hidden: Uint8Array;
  readonly hns: Uint8Array;
  /** For a hold being judged: the time its life last was full; Infinity while it is held. */
  readonly lifeFrom: Float64Array;
  /** When a hold was let go. */
  readonly letGoSeconds: Float64Array;
  /** Which panels are down. */
  readonly pressed: Uint8Array;

  private readonly timing: TimingData;
  private readonly failOff: boolean;
  private readonly crossTime: Float64Array;
  private readonly missTime: Float64Array;
  private readonly endCross: Float64Array;
  private readonly rowFirst: Int32Array;
  private readonly rowEnd: Int32Array;
  private readonly rowHandled: Uint8Array;
  private readonly comboMul: Int32Array;
  private readonly missComboMul: Int32Array;
  private readonly trackNotes: Int32Array[];
  private readonly holdMoment: Float64Array;
  private readonly holdResult: Uint8Array;
  private readonly pending: Int32Array;
  private pendingCount = 0;
  private crossIdx = 0;
  private missIdx = 0;
  private time = -Infinity;
  /** When the last time-driven judgement of the chart is due. */
  readonly lastJudgementSeconds: number;

  constructor(notes: readonly TimedNote[], timing: TimingData, numTracks: number, options: JudgeOptions = {}) {
    const n = notes.length;
    this.count = n;
    this.numTracks = numTracks;
    this.timing = timing;
    this.autoplay = options.autoplay ?? false;
    this.failOff = options.failType === 'off';
    this.keeper = new ScoreKeeper(chartTotals(notes));

    this.row = new Int32Array(n);
    this.endRow = new Int32Array(n);
    this.track = new Uint8Array(n);
    this.type = new Uint8Array(n);
    this.roll = new Uint8Array(n);
    this.judgable = new Uint8Array(n);
    this.seconds = new Float64Array(n);
    this.endSeconds = new Float64Array(n);
    this.tns = new Uint8Array(n);
    this.offset = new Float64Array(n);
    this.hidden = new Uint8Array(n);
    this.hns = new Uint8Array(n);
    this.lifeFrom = new Float64Array(n).fill(Infinity);
    this.letGoSeconds = new Float64Array(n).fill(Infinity);
    this.pressed = new Uint8Array(numTracks);
    this.crossTime = new Float64Array(n);
    this.missTime = new Float64Array(n);
    this.endCross = new Float64Array(n);
    this.rowFirst = new Int32Array(n);
    this.rowEnd = new Int32Array(n);
    this.rowHandled = new Uint8Array(n);
    this.comboMul = new Int32Array(n);
    this.missComboMul = new Int32Array(n);
    this.holdMoment = new Float64Array(n).fill(Infinity);
    this.holdResult = new Uint8Array(n);

    // Row times are needed for many rows more than once.
    const rowSeconds = new Map<number, number>();
    const secondsAtRow = (row: number): number => {
      let s = rowSeconds.get(row);
      if (s === undefined) {
        s = timing.secondsAtRow(row);
        rowSeconds.set(row, s);
      }
      return s;
    };
    // The time at which the rounded song row (BeatToNoteRow of the song beat) reaches `row`:
    // halfway, in beats, between leaving the row before and arriving at this one. The tempo
    // is constant in between, so that is halfway in time as well; across a warp both are
    // the same moment.
    const roundedRowReached = (row: number): number => {
      const left = secondsAtRow(row - 1) + timing.stopAtRow(row - 1);
      const arrived = secondsAtRow(row) - timing.delayAtRow(row);
      return (left + arrived) / 2;
    };

    const perTrack: number[][] = [];
    for (let t = 0; t < numTracks; t++) perTrack.push([]);
    let holds = 0;
    let cross = -Infinity;
    let miss = -Infinity;
    let last = -Infinity;
    for (let i = 0; i < n; i++) {
      const note = notes[i]!;
      this.row[i] = note.row;
      this.track[i] = note.track;
      this.type[i] = TYPE_CODE[note.type];
      this.judgable[i] = note.judgable ? 1 : 0;
      this.seconds[i] = note.seconds;
      perTrack[note.track]!.push(i);

      // Time-driven things happen in note order: keep their times from going backwards.
      cross = Math.max(cross, note.seconds);
      this.crossTime[i] = cross;
      // UpdateTapNotesMissedOlderThan: the row is older than the rounded row of half a second
      // ago, which counts one more during a stop.
      const passed = timing.stopAtRow(note.row) > 0 ? note.seconds : roundedRowReached(note.row + 1);
      miss = Math.max(miss, passed + MAX_STEP_DISTANCE_SECONDS);
      this.missTime[i] = miss;
      last = Math.max(last, miss);

      if (note.type === 'HoldHead') {
        holds++;
        this.roll[i] = note.subType === 'Roll' ? 1 : 0;
        this.endRow[i] = note.row + note.durationRows;
        this.endSeconds[i] = note.endSeconds ?? note.seconds;
        this.endCross[i] = roundedRowReached(this.endRow[i]!);
        last = Math.max(last, this.endCross[i]!);
      } else {
        this.endRow[i] = note.row;
        this.endSeconds[i] = note.seconds;
      }

      const first = i > 0 && notes[i - 1]!.row === note.row ? this.rowFirst[i - 1]! : i;
      this.rowFirst[i] = first;
      if (first === i) {
        const segment = segmentIndexAtRow(timing.combos, note.row);
        this.comboMul[i] = segment >= 0 ? timing.combos[segment]!.combo : 1;
        this.missComboMul[i] = segment >= 0 ? timing.combos[segment]!.missCombo : 1;
      }
    }
    for (let i = n - 1; i >= 0; i--) {
      this.rowEnd[i] = i + 1 < n && this.rowFirst[i + 1] === this.rowFirst[i] ? this.rowEnd[i + 1]! : i + 1;
    }
    this.trackNotes = perTrack.map((list) => Int32Array.from(list));
    this.pending = new Int32Array(Math.max(1, holds));
    this.lastJudgementSeconds = n > 0 ? last : 0;
  }

  /** The music time judging has got to. */
  get now(): number {
    return this.time;
  }

  /** True once nothing is left to judge. */
  get finished(): boolean {
    this.skipJudged();
    return this.missIdx >= this.count && this.pendingCount === 0;
  }

  // ------------------------------------------------------------------ input

  /**
   * A panel went down at music time `seconds`. Inputs must come in time order. An input may
   * be older than the time advance() has reached (it was delivered late): it is still judged
   * at its own time, but what the clock decided in between stands. Callers keep advance()
   * behind the present by more than the input delivery delay so that this stays rare.
   */
  press(track: number, seconds: number): void {
    if (this.autoplay) return;
    const t = seconds;
    this.advance(t);
    this.pressed[track] = 1;
    // A held hold stops running out.
    for (let p = 0; p < this.pendingCount; p++) {
      const i = this.pending[p]!;
      if (this.track[i] !== track || this.roll[i] || this.tns[i] === TNS.Miss) continue;
      this.lifeFrom[i] = Infinity;
      this.updateHoldMoment(i);
    }
    this.step(track, t, false);
  }

  /** A panel came up at music time `seconds`. */
  release(track: number, seconds: number): void {
    if (this.autoplay) return;
    const t = seconds;
    this.advance(t);
    this.pressed[track] = 0;
    for (let p = 0; p < this.pendingCount; p++) {
      const i = this.pending[p]!;
      if (this.track[i] !== track || this.roll[i] || this.tns[i] === TNS.Miss) continue;
      // Life runs from the release, or from the head's own time for one hit early.
      this.lifeFrom[i] = Math.max(t, this.seconds[i]!);
      this.updateHoldMoment(i);
    }
    this.step(track, t, true);
  }

  /** Applies everything the clock decides up to music time `seconds`, in time order. */
  advance(seconds: number): void {
    const n = this.count;
    for (;;) {
      let hold = -1;
      let holdAt = Infinity;
      for (let p = 0; p < this.pendingCount; p++) {
        const i = this.pending[p]!;
        if (this.holdMoment[i]! < holdAt) {
          holdAt = this.holdMoment[i]!;
          hold = i;
        }
      }
      const crossAt = this.crossIdx < n ? this.crossTime[this.crossIdx]! : Infinity;
      this.skipJudged();
      const missAt = this.missIdx < n ? this.missTime[this.missIdx]! : Infinity;

      if (holdAt === Infinity && crossAt === Infinity && missAt === Infinity) break;
      // Ties as in Player::Update: holds, then crossed rows, then misses.
      if (holdAt <= crossAt && holdAt <= missAt) {
        if (!(holdAt <= seconds)) break;
        this.finishHold(hold, this.holdResult[hold]!, holdAt);
      } else if (crossAt <= missAt) {
        if (!(crossAt <= seconds)) break;
        this.cross(this.crossIdx++, crossAt);
      } else {
        if (!(missAt <= seconds)) break;
        this.miss(this.missIdx++, missAt);
      }
    }
    if (seconds > this.time) this.time = seconds;
  }

  /** Judges everything that is left, as when the song has ended. */
  finish(): void {
    this.advance(Infinity);
  }

  // ------------------------------------------------------------- clock side

  /** Moves the miss pointer past notes that will not become a miss. */
  private skipJudged(): void {
    const n = this.count;
    while (this.missIdx < n) {
      const i = this.missIdx;
      const type = this.type[i]!;
      // NeedsTapJudging, and rows in warps and fake sections are left alone.
      if (this.tns[i] === TNS.None && this.judgable[i] && type <= NOTE_LIFT) return;
      this.missIdx++;
    }
  }

  /** Player::CrossedRows for one note. */
  private cross(i: number, t: number): void {
    const type = this.type[i]!;
    if (this.autoplay) {
      // Mines are avoided; fakes and rows that cannot be judged are passed over.
      if (type === NOTE_MINE || type > NOTE_LIFT || this.tns[i] !== TNS.None || !this.judgable[i]) return;
      this.setTapScore(i, TNS.W1, 0, t);
      return;
    }
    if (type === NOTE_MINE && this.pressed[this.track[i]!] && this.tns[i] === TNS.None) {
      // Holding the panel while a mine crosses sets it off.
      this.refreshRoll(this.track[i]!, this.row[i]!, t);
      this.setTapScore(i, TNS.HitMine, 0, t);
    }
  }

  /** Player::UpdateTapNotesMissedOlderThan for one note. */
  private miss(i: number, t: number): void {
    if (this.tns[i] !== TNS.None) return;
    if (this.type[i] === NOTE_MINE) {
      this.tns[i] = TNS.AvoidMine;
      this.hidden[i] = 1;
      return;
    }
    this.tns[i] = TNS.Miss;
    if (this.type[i] === NOTE_HOLD_HEAD) this.headJudged(i, t);
    this.rowJudged(i, t, false);
  }

  // -------------------------------------------------------------- step side

  private lowerBound(list: Int32Array, row: number): number {
    let lo = 0;
    let hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.row[list[mid]!]! < row) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** The start of Player::Step: a press on a roll that is under way fills its life. */
  private refreshRoll(track: number, songRow: number, t: number): void {
    const list = this.trackNotes[track]!;
    const start = Math.max(0, songRow - ROWS_PER_BEAT);
    let k = this.lowerBound(list, start);
    // GetTapNoteRangeInclusive: a hold that began before the range and reaches into it.
    if (k > 0) {
      const before = list[k - 1]!;
      if (this.type[before] === NOTE_HOLD_HEAD && this.endRow[before]! > start) k--;
    }
    for (; k < list.length; k++) {
      const i = list[k]!;
      if (this.row[i]! >= songRow + 1) break;
      if (this.type[i] !== NOTE_HOLD_HEAD || !this.roll[i] || this.hns[i] !== HNS.None) continue;
      if (this.row[i]! <= songRow) {
        const tns = this.tns[i]!;
        if (tns !== TNS.None && tns !== TNS.Miss) {
          this.lifeFrom[i] = Math.max(t, this.seconds[i]!);
          this.updateHoldMoment(i);
        }
        break;
      }
    }
  }

  /** GetClosestNoteDirectional's test. */
  private canStepOn(i: number): boolean {
    return this.judgable[i] === 1 && this.type[i] !== NOTE_AUTO_KEYSOUND && this.tns[i] === TNS.None;
  }

  /** Player::Step for a press or release by the player at music time `t`. */
  private step(track: number, t: number, release: boolean): void {
    const timing = this.timing;
    const songRow = beatToNoteRow(timing.beatAtSeconds(t));
    if (!release) this.refreshRoll(track, songRow, t);

    const searchRows =
      Math.max(
        beatToNoteRow(timing.beatAtSeconds(t + STEP_SEARCH_SECONDS)) - songRow,
        songRow - beatToNoteRow(timing.beatAtSeconds(t - STEP_SEARCH_SECONDS)),
      ) + ROWS_PER_BEAT;

    // GetClosestNote: the nearest unjudged note by row, ahead or behind; a tie goes ahead.
    const list = this.trackNotes[track]!;
    const at = this.lowerBound(list, songRow);
    let next = -1;
    for (let k = at; k < list.length && this.row[list[k]!]! < songRow + searchRows; k++) {
      if (this.canStepOn(list[k]!)) {
        next = list[k]!;
        break;
      }
    }
    let prev = -1;
    for (let k = at - 1; k >= 0 && this.row[list[k]!]! >= songRow - searchRows; k--) {
      if (this.canStepOn(list[k]!)) {
        prev = list[k]!;
        break;
      }
    }
    let i: number;
    if (next < 0) i = prev;
    else if (prev < 0) i = next;
    else i = Math.abs(songRow - this.row[next]!) > Math.abs(songRow - this.row[prev]!) ? prev : next;
    if (i < 0) return;

    // Positive: the step came before the note.
    const noteOffset = this.seconds[i]! - t;
    const distance = Math.abs(noteOffset);
    let score: number = TNS.None;
    if (this.type[i] === NOTE_MINE) {
      if (!release && distance <= WINDOW.Mine) score = TNS.HitMine;
    } else if ((this.type[i] === NOTE_LIFT) === release) {
      if (distance <= WINDOW.W1) score = TNS.W1;
      else if (distance <= WINDOW.W2) score = TNS.W2;
      else if (distance <= WINDOW.W3) score = TNS.W3;
      else if (distance <= WINDOW.W4) score = TNS.W4;
      else if (distance <= WINDOW.W5) score = TNS.W5;
    }
    if (score !== TNS.None) this.setTapScore(i, score, -noteOffset, t);
  }

  /** The end of Player::Step: a note has been given a score. */
  private setTapScore(i: number, score: number, offset: number, t: number): void {
    this.tns[i] = score;
    this.offset[i] = offset;
    const type = this.type[i]!;
    if (type === NOTE_MINE) {
      // UpdateJudgedRows, mines: only on rows that can be judged.
      if (this.hidden[i] || !this.judgable[i]) return;
      this.hidden[i] = 1;
      this.life.changeForTap(TNS.HitMine);
      this.keeper.handleMineHit();
      this.onEvent?.(EV_MINE_HIT, t, this.track[i]!, TNS.HitMine, 0, i);
      this.checkFail(t);
      return;
    }
    if (type === NOTE_FAKE) return; // takes the step, counts for nothing
    if (type === NOTE_HOLD_HEAD) this.headJudged(i, t);
    this.rowJudged(i, t, true);
  }

  /**
   * UpdateJudgedRows and HandleTapRowScore for the row of note `i`, once every note in it is
   * judged; and FlashGhostRow when a step completed it.
   */
  private rowJudged(i: number, t: number, byStep: boolean): void {
    if (!this.judgable[i]) return;
    const first = this.rowFirst[i]!;
    const end = this.rowEnd[i]!;

    // LastTapNoteWithResult: a missed note if there is one, else the one hit last (of two
    // hit at the same moment, the one on the higher track).
    let last = -1;
    let lastOffset = -9999;
    let missed = -1;
    let taps = 0;
    let firstTrack = -1;
    for (let j = first; j < end; j++) {
      const type = this.type[j]!;
      if (type === NOTE_MINE || type === NOTE_FAKE || type === NOTE_AUTO_KEYSOUND) continue;
      const tns = this.tns[j]!;
      if (tns < TNS.Miss) return; // not completely judged yet
      taps++;
      if (firstTrack < 0) firstTrack = this.track[j]!;
      if (tns === TNS.Miss) {
        if (missed < 0) missed = j;
      } else if (this.offset[j]! >= lastOffset) {
        lastOffset = this.offset[j]!;
        last = j;
      }
    }
    if (missed >= 0) last = missed;
    if (last < 0) return; // a row of mines only
    const score = this.tns[last]!;

    if (byStep) {
      for (let j = first; j < end; j++) {
        const type = this.type[j]!;
        if (type === NOTE_MINE || type === NOTE_FAKE || type === NOTE_AUTO_KEYSOUND || this.hidden[j]) continue;
        if (score >= MIN_TNS_TO_HIDE_NOTES) this.hidden[j] = 1;
        this.onEvent?.(EV_GHOST, t, this.track[j]!, score, 0, j);
      }
    }

    if (this.rowHandled[first]) return;
    this.rowHandled[first] = 1;
    this.keeper.handleTapRow(score, taps, this.comboMul[first]!, this.missComboMul[first]!);
    this.life.changeForTap(score);
    this.onEvent?.(EV_TAP_JUDGMENT, t, firstTrack, score, this.offset[last]!, last);
    this.checkFail(t);
  }

  // ------------------------------------------------------------------ holds

  /** A hold's head was hit or missed: from now on Player::UpdateHoldNotes has work to do. */
  private headJudged(i: number, t: number): void {
    if (this.hns[i] !== HNS.None) return;
    const hit = this.tns[i] !== TNS.Miss;
    if (t >= this.endCross[i]!) {
      // Already over. Stepped on: held (nothing could run out). Not stepped on: missed.
      this.finishHold(i, hit ? RESULT_HELD : RESULT_MISSED, t);
      return;
    }
    for (let p = 0; p < this.pendingCount; p++) if (this.pending[p] === i) return;
    this.pending[this.pendingCount++] = i;
    if (hit) {
      // Life is full until the head's own time (CrossedRows) and while the panel is down.
      const held = !this.roll[i] && (this.autoplay || this.pressed[this.track[i]!] === 1);
      this.lifeFrom[i] = held ? Infinity : Math.max(t, this.seconds[i]!);
    }
    this.updateHoldMoment(i);
  }

  /** Works out what happens to a hold next if nothing else is pressed or released. */
  private updateHoldMoment(i: number): void {
    const end = this.endCross[i]!;
    let at = end;
    let result: number = RESULT_HELD;
    if (this.tns[i] === TNS.Miss) {
      result = RESULT_MISSED;
    } else if (!this.autoplay) {
      const empty = this.lifeFrom[i]! + (this.roll[i] ? WINDOW.Roll : WINDOW.Hold);
      // At the end row a hold counts as held whatever the panel does; a roll's life still
      // runs down in that last update.
      if (this.roll[i] ? empty <= end : empty < end) {
        at = empty;
        result = RESULT_LET_GO;
      }
    }
    this.holdMoment[i] = at;
    this.holdResult[i] = result;
  }

  /** The end of Player::UpdateHoldNotes, and HandleHoldScore. */
  private finishHold(i: number, hns: number, t: number): void {
    for (let p = 0; p < this.pendingCount; p++) {
      if (this.pending[p] !== i) continue;
      this.pending[p] = this.pending[--this.pendingCount]!;
      break;
    }
    this.hns[i] = hns;
    this.holdMoment[i] = Infinity;
    if (hns === RESULT_LET_GO) this.letGoSeconds[i] = t;
    this.keeper.handleHold(hns);
    this.life.changeForHold(hns);
    this.onEvent?.(EV_HOLD_JUDGMENT, t, this.track[i]!, hns, 0, i);
    this.checkFail(t);
  }

  /** ScreenGameplay, fail type Immediate: out of life means failed, once and for good. */
  private checkFail(t: number): void {
    if (this.failOff || this.life.failed || !this.life.isFailing) return;
    this.life.failed = true;
    this.keeper.failed = true;
    this.onEvent?.(EV_FAILED, t, -1, 0, 0, -1);
  }
}
