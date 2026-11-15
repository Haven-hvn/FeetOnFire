// The life bar. Port of LifeMeterBar.cpp with default preferences: normal drain, life
// difficulty 1.0, no progressive bar, harsh hot penalty, five good steps to regain after a
// mistake. Life is a 32-bit float, as in the original. Pure: no browser dependencies.

import {
  HNS,
  HOLD_LIFE_CHANGE,
  LIFE_DANGER,
  LIFE_HOT,
  LIFE_HOT_PENALTY,
  LIFE_INITIAL,
  MAX_REGEN_COMBO_AFTER_MISS,
  REGEN_COMBO_AFTER_MISS,
  TAP_LIFE_CHANGE,
} from './constants.ts';

const f32 = Math.fround;

export class LifeMeter {
  life: number = LIFE_INITIAL;
  /** Once set, life no longer changes (PlayerStageStats::m_bFailed). */
  failed = false;
  /** Good steps still needed before life comes back. */
  comboToRegainLife = 0;
  missCombo = 0;

  get isHot(): boolean {
    return this.life >= LIFE_HOT;
  }

  get isInDanger(): boolean {
    return this.life < LIFE_DANGER;
  }

  /** LifeMeterBar::IsFailing with a passmark of 0. */
  get isFailing(): boolean {
    return this.life <= 0;
  }

  /** LifeMeterBar::ChangeLife(TapNoteScore). */
  changeForTap(tns: number): void {
    let delta = TAP_LIFE_CHANGE[tns]!;
    if (this.isHot && delta < 0) delta = Math.min(delta, LIFE_HOT_PENALTY);
    this.change(delta);
  }

  /** LifeMeterBar::ChangeLife(HoldNoteScore, TapNoteScore). */
  changeForHold(hns: number): void {
    let delta = HOLD_LIFE_CHANGE[hns]!;
    if (this.isHot && hns === HNS.LetGo) delta = LIFE_HOT_PENALTY;
    this.change(delta);
  }

  /** LifeMeterBar::ChangeLife(float). */
  private change(delta: number): void {
    if (delta >= 0) {
      this.missCombo = 0;
      this.comboToRegainLife = Math.max(this.comboToRegainLife - 1, 0);
      if (this.comboToRegainLife > 0) delta = 0;
    } else {
      this.missCombo++;
      const next = Math.min(MAX_REGEN_COMBO_AFTER_MISS, this.comboToRegainLife + REGEN_COMBO_AFTER_MISS);
      this.comboToRegainLife = Math.max(this.comboToRegainLife, next);
    }
    if (this.failed) return;
    this.life = Math.min(1, Math.max(0, f32(this.life + delta)));
  }
}
