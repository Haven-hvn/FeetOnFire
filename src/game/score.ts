// Score keeping: dance points, percent, score, combo, per-judgement counts and the grade.
// Port of ScoreKeeperNormal.cpp and the parts of PlayerStageStats.cpp it feeds, for the
// `dance` game (rows are judged as one; no hold checkpoints). Pure: no browser dependencies.

import {
  GRADE_FAILED,
  GRADE_TIERS,
  HNS,
  HOLD_DANCE_POINTS,
  HOLD_GRADE_POINTS,
  MAX_POSSIBLE_POINTS,
  MAX_SCORE_TO_INCREMENT_MISS_COMBO,
  MIN_SCORE_TO_CONTINUE_COMBO,
  MIN_SCORE_TO_MAINTAIN_COMBO,
  NUM_HNS,
  NUM_TNS,
  TAP_DANCE_POINTS,
  TAP_GRADE_POINTS,
  TNS,
} from './constants.ts';

const f32 = Math.fround;

/** What a chart can score, from NoteDataUtil::CalculateRadarValues. Judgable rows only. */
export interface ChartTotals {
  /** Rows with at least one tap, hold head or lift. */
  tapsAndHolds: number;
  holds: number;
  rolls: number;
}

/** ScoreKeeperNormal::GetPossibleDancePoints. */
export function possibleDancePoints(totals: ChartTotals): number {
  return totals.tapsAndHolds * TAP_DANCE_POINTS[TNS.W1]! + (totals.holds + totals.rolls) * HOLD_DANCE_POINTS[HNS.Held]!;
}

/** ScoreKeeperNormal::GetPossibleGradePoints. */
export function possibleGradePoints(totals: ChartTotals): number {
  return totals.tapsAndHolds * TAP_GRADE_POINTS[TNS.W1]! + (totals.holds + totals.rolls) * HOLD_GRADE_POINTS[HNS.Held]!;
}

/**
 * PlayerStageStats::MakePercentScore: 0..1, cut (not rounded) to two decimals of a percent.
 * In 32-bit floats, as the original.
 */
export function makePercentScore(actual: number, possible: number): number {
  if (possible === 0) return 0;
  if (actual === possible) return 1;
  let percent = f32(actual / f32(possible));
  percent = Math.max(0, percent);
  const interval = f32(Math.pow(f32(0.1), 4)); // 3 digits + PercentScoreDecimalPlaces (2) - 1
  percent = f32(percent + f32(0.000001));
  // ftruncf: int(f / interval) * interval
  return f32(Math.trunc(f32(percent / interval)) * interval);
}

/** GetGradeFromPercent: index of the first tier the fraction reaches. */
export function gradeFromPercent(percent: number): number {
  for (let tier = 0; tier < GRADE_TIERS.length; tier++) {
    if (percent >= GRADE_TIERS[tier]!) return tier;
  }
  return GRADE_FAILED;
}

/** ScoreKeeperNormal.cpp GetScore: int(int64(p) * n * Z / S), as exact integer division. */
function stepScore(p: number, z: number, sum: number, n: number): number {
  const a = p * n * z; // below 2^53 for any chart
  let q = Math.floor(a / sum);
  while (q * sum > a) q--;
  while ((q + 1) * sum <= a) q++;
  return q;
}

export class ScoreKeeper {
  readonly totals: ChartTotals;
  readonly possibleDancePoints: number;
  readonly possibleGradePoints: number;
  /** Rows with a tap or hold head, plus holds, plus rolls: the number of scored steps. */
  readonly numTapsAndHolds: number;

  /** Rows counted per TapNoteScore (a row counts once, times its combo segment). */
  readonly tapNoteScores = new Int32Array(NUM_TNS);
  readonly holdNoteScores = new Int32Array(NUM_HNS);
  actualDancePoints = 0;
  curPossibleDancePoints = 0;
  curCombo = 0;
  maxCombo = 0;
  curMissCombo = 0;
  score = 0;
  curMaxScore = 0;
  /** Set by the judge when the life meter runs out (fail type Immediate). */
  failed = false;

  private tapNotesHit = 0;
  private pointBonus = MAX_POSSIBLE_POINTS;

  constructor(totals: ChartTotals) {
    this.totals = totals;
    this.possibleDancePoints = possibleDancePoints(totals);
    this.possibleGradePoints = possibleGradePoints(totals);
    this.numTapsAndHolds = totals.tapsAndHolds + totals.holds + totals.rolls;
  }

  /** ScoreKeeperNormal::AddScoreInternal. */
  private addScore(tns: number): void {
    const p = tns === TNS.W1 ? 10 : tns === TNS.W2 ? 9 : tns === TNS.W3 ? 5 : 0;
    this.tapNotesHit++;
    const n = this.numTapsAndHolds;
    const sum = (n * (n + 1)) / 2;
    const z = MAX_POSSIBLE_POINTS / 10;

    if (this.failed) {
      // No multiplier once failed; kept divisible by 5, rounding to the nearest.
      this.score += p;
      if (p > 0) this.score = Math.trunc((this.score + 2) / 5) * 5;
    } else {
      this.score += stepScore(p, z, sum, this.tapNotesHit);
    }

    const most = stepScore(10, z, sum, this.tapNotesHit);
    this.pointBonus -= most;
    this.curMaxScore += most;

    if (this.tapNotesHit === n && tns >= TNS.W2) {
      // What rounding left over goes to the last step.
      if (!this.failed) this.score += this.pointBonus;
      this.curMaxScore += this.pointBonus;
    }
  }

  /**
   * ScoreKeeperNormal::HandleTapRowScore for a completely judged row: `numTaps` taps, hold
   * heads and lifts, judged as `tns` (the score of the last one hit, or Miss).
   * `combo` and `missCombo` are the multipliers of the row's combo segment.
   */
  handleTapRow(tns: number, numTaps: number, combo: number, missCombo: number): void {
    if (numTaps <= 0) return;

    // HandleTapNoteScoreInternal
    if (!this.failed) this.actualDancePoints += TAP_DANCE_POINTS[tns]!;
    if (tns >= MIN_SCORE_TO_CONTINUE_COMBO) this.tapNoteScores[tns]! += combo;
    else if (tns < MIN_SCORE_TO_MAINTAIN_COMBO) this.tapNoteScores[tns]! += missCombo;
    else this.tapNoteScores[tns]! += 1;
    this.curPossibleDancePoints += TAP_DANCE_POINTS[TNS.W1]!;

    // HandleRowComboInternal (ComboIsPerRow off, MissComboIsPerRow on)
    if (tns >= MIN_SCORE_TO_CONTINUE_COMBO) {
      this.curMissCombo = 0;
      this.curCombo += numTaps * combo;
    } else if (tns < MIN_SCORE_TO_MAINTAIN_COMBO) {
      this.curCombo = 0;
      if (tns <= MAX_SCORE_TO_INCREMENT_MISS_COMBO) this.curMissCombo += missCombo;
    }

    this.addScore(tns);
    if (this.curCombo > this.maxCombo) this.maxCombo = this.curCombo;
  }

  /** ScoreKeeperNormal::HandleHoldScore. */
  handleHold(hns: number): void {
    if (!this.failed) this.actualDancePoints += HOLD_DANCE_POINTS[hns]!;
    this.curPossibleDancePoints += HOLD_DANCE_POINTS[HNS.Held]!;
    this.holdNoteScores[hns]!++;
    if (hns === HNS.Held) this.addScore(TNS.W1);
    else if (hns === HNS.LetGo) this.addScore(TNS.W4);
  }

  /** ScoreKeeperNormal::HandleTapScore for a mine that was hit. */
  handleMineHit(): void {
    if (!this.failed) this.actualDancePoints += TAP_DANCE_POINTS[TNS.HitMine]!;
    this.tapNoteScores[TNS.HitMine]!++;
  }

  /** PlayerStageStats::GetPercentDancePoints: 0..1. */
  percentDancePoints(): number {
    return makePercentScore(this.actualDancePoints, this.possibleDancePoints);
  }

  /** PlayerStageStats::FullComboOfScore. */
  fullComboOfScore(tns: number): boolean {
    if (this.holdNoteScores[HNS.LetGo]! > 0) return false;
    if (this.tapNoteScores[TNS.CheckpointMiss]! > 0) return false;
    for (let i = TNS.Miss; i < tns; i++) if (this.tapNoteScores[i]! > 0) return false;
    for (let i = tns; i < NUM_TNS; i++) if (this.tapNoteScores[i]! > 0) return true;
    return false;
  }

  /** PlayerStageStats::GetGrade: tier index (0 is best), or GRADE_FAILED. */
  grade(): number {
    if (this.failed) return GRADE_FAILED;
    let actual = 0;
    for (let tns = 0; tns < NUM_TNS; tns++) actual = f32(actual + this.tapNoteScores[tns]! * TAP_GRADE_POINTS[tns]!);
    for (let hns = 0; hns < NUM_HNS; hns++) actual = f32(actual + this.holdNoteScores[hns]! * HOLD_GRADE_POINTS[hns]!);
    const percent = this.possibleGradePoints === 0 ? 0 : f32(actual / this.possibleGradePoints);
    const grade = gradeFromPercent(percent);
    // GradeTier02IsAllW2s: the two top tiers are for full combos of W1 and of W2.
    if (this.fullComboOfScore(TNS.W1)) return 0;
    if (this.fullComboOfScore(TNS.W2)) return 1;
    return Math.max(grade, 2);
  }
}
