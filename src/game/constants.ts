// Judging, scoring and life constants: StepMania 5.1 defaults for the `dance` game with the
// `_fallback` theme metrics (docs/HANDOVER.md section 6.1 lists the sources).
//
// Scores are small integers in the original's enum order, so that comparisons such as
// "W3 or better" read the same as in the C++.

const f32 = Math.fround;

/** TapNoteScore. */
export const TNS = {
  None: 0,
  HitMine: 1,
  AvoidMine: 2,
  CheckpointMiss: 3,
  Miss: 4,
  W5: 5,
  W4: 6,
  W3: 7,
  W2: 8,
  W1: 9,
  CheckpointHit: 10,
} as const;
export const NUM_TNS = 11;
export const TNS_NAMES = ['None', 'HitMine', 'AvoidMine', 'CheckpointMiss', 'Miss', 'W5', 'W4', 'W3', 'W2', 'W1', 'CheckpointHit'] as const;

/** HoldNoteScore. */
export const HNS = {
  None: 0,
  LetGo: 1,
  Held: 2,
  Missed: 3,
} as const;
export const NUM_HNS = 4;
export const HNS_NAMES = ['None', 'LetGo', 'Held', 'Missed'] as const;

/** Timing windows in seconds (PrefsManager TimingWindowSeconds*, scale 1, add 0), as 32-bit floats. */
export const WINDOW = {
  W1: f32(0.0225),
  W2: f32(0.045),
  W3: f32(0.09),
  W4: f32(0.135),
  W5: f32(0.18),
  Mine: f32(0.09),
  Hold: f32(0.25),
  Roll: f32(0.5),
} as const;

/** Player::GetMaxStepDistanceSeconds at rate 1: the largest window (Roll). A miss is registered this long after a note. */
export const MAX_STEP_DISTANCE_SECONDS = 0.5;
/** Player.cpp StepSearchDistance. */
export const STEP_SEARCH_SECONDS = 1.0;

/** [Gameplay] MinScoreToContinueCombo and MinScoreToMaintainCombo. */
export const MIN_SCORE_TO_CONTINUE_COMBO = TNS.W3;
export const MIN_SCORE_TO_MAINTAIN_COMBO = TNS.W3;
/** [Gameplay] MaxScoreToIncrementMissCombo. */
export const MAX_SCORE_TO_INCREMENT_MISS_COMBO = TNS.Miss;
/** PlayerOptions MinTNSToHideNotes. */
export const MIN_TNS_TO_HIDE_NOTES = TNS.W3;

/** [ScoreKeeperNormal] PercentScoreWeight*, by TapNoteScore. */
export const TAP_DANCE_POINTS: readonly number[] = [0, -2, 0, 0, 0, 0, 0, 1, 2, 3, 3];
/** [ScoreKeeperNormal] PercentScoreWeight*, by HoldNoteScore. */
export const HOLD_DANCE_POINTS: readonly number[] = [0, 0, 3, 0];
/** [ScoreKeeperNormal] GradeWeight*, by TapNoteScore (AvoidMine and None count nothing). */
export const TAP_GRADE_POINTS: readonly number[] = [0, -8, 0, -8, -8, -4, 0, 1, 2, 2, 2];
/** [ScoreKeeperNormal] GradeWeight*, by HoldNoteScore. */
export const HOLD_GRADE_POINTS: readonly number[] = [0, 0, 6, 0];

/** [LifeMeterBar] LifePercentChange*, by TapNoteScore (None changes life as a Miss does). */
export const TAP_LIFE_CHANGE: readonly number[] = [-0.08, -0.16, 0, -0.08, -0.08, -0.04, 0, 0.004, 0.008, 0.008, 0.008].map(f32);
/** [LifeMeterBar] LifePercentChange*, by HoldNoteScore. */
export const HOLD_LIFE_CHANGE: readonly number[] = [0, -0.08, 0.008, 0].map(f32);
export const LIFE_INITIAL = 0.5;
export const LIFE_HOT = 1.0;
export const LIFE_DANGER = 0.2;
/** PrefsManager HarshHotLifePenalty: the least a mistake costs while the bar is full. */
export const LIFE_HOT_PENALTY = f32(-0.1);
/** PrefsManager RegenComboAfterMiss and MaxRegenComboAfterMiss. */
export const REGEN_COMBO_AFTER_MISS = 5;
export const MAX_REGEN_COMBO_AFTER_MISS = 5;

/** ScoreKeeperNormal: the most a normal-length song can score. */
export const MAX_POSSIBLE_POINTS = 100_000_000;

/** [PlayerStageStats] GradePercentTier01..07 of the `_fallback` theme. */
export const GRADE_TIERS: readonly number[] = [1.0, 1.0, 0.93, 0.8, 0.65, 0.45, -99999].map(f32);
/** Names shown for the tiers; index 7 is Failed. */
export const GRADE_NAMES = ['AAAA', 'AAA', 'AA', 'A', 'B', 'C', 'D', 'Failed'] as const;
export const GRADE_FAILED = 7;
