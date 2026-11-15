// What is on screen during play: the backdrop, the lanes, receptors, notes, holds, mines,
// flashes, the judgement and combo, the life bar, the percent score and the song's name.
// Reads the judge's state; draws with Renderer. Nothing is allocated per frame.
//
// Lengths are StepMania's logical pixels from the centre of the screen: 480 high, y down.

import { HNS, LIFE_DANGER, TNS } from './constants.ts';
import { ARROW_SIZE, columnX, DRAW_DISTANCE_AFTER, DRAW_DISTANCE_BEFORE, quantisation, SCREEN_HEIGHT, type Scroller } from './field.ts';
import {
  EV_FAILED,
  EV_GHOST,
  EV_HOLD_JUDGMENT,
  EV_MINE_HIT,
  EV_TAP_JUDGMENT,
  NOTE_AUTO_KEYSOUND,
  NOTE_FAKE,
  NOTE_HOLD_HEAD,
  NOTE_LIFT,
  NOTE_MINE,
  type Judge,
} from './judge.ts';
import type { Renderer, Sprite } from './render.ts';

const HALF_PI = Math.PI / 2;
/** Turn of the up-pointing arrow for the columns of dance: left, down, up, right. */
const ANGLE = [-HALF_PI, Math.PI, 0, HALF_PI];

// Note colours by quantisation: 4th, 8th, 12th, 16th, 24th, 32nd, 48th, 64th, 192nd.
const QUANT_R = [1.0, 0.16, 0.66, 1.0, 1.0, 1.0, 0.2, 0.3, 0.62];
const QUANT_G = [0.16, 0.42, 0.2, 0.84, 0.42, 0.55, 0.9, 0.9, 0.66];
const QUANT_B = [0.14, 1.0, 0.95, 0.1, 0.78, 0.1, 0.9, 0.3, 0.7];

// Light of a hit, by TapNoteScore (index): only Miss .. W1 are used.
const HIT_R = [1, 1, 1, 1, 1.0, 0.72, 0.3, 0.25, 1.0, 0.55, 1];
const HIT_G = [1, 1, 1, 1, 0.2, 0.3, 0.55, 0.95, 0.82, 0.92, 1];
const HIT_B = [1, 1, 1, 1, 0.2, 0.95, 1.0, 0.4, 0.2, 1.0, 1];

const JUDGMENT_MS = 650;
const HOLD_JUDGMENT_MS = 520;
const FLASH_MS = 240;
const MINE_MS = 420;
const COMBO_POP_MS = 130;
/** Notes this long past are no longer looked at. */
const KEEP_SECONDS = 3;
/** Notes further ahead than this are not looked at. */
const AHEAD_SECONDS = 30;
const MAX_NOTES_PER_FRAME = 6000;
/** [Combo] ShowComboAt / ShowMissesAt. */
const SHOW_COMBO_AT = 2;
const HOLD_WIDTH = ARROW_SIZE * 0.72;
const PARTICLES = 128;
const PARTICLE_SECONDS = 0.45;
const PARTICLES_PER_HIT = 8;

export interface SceneInfo {
  /** When the first note comes and when the last judgement is due: the song's span. */
  firstSeconds: number;
  lastSeconds: number;
  /** Colour of the chart's difficulty. */
  level: [number, number, number];
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

export class Scene {
  private readonly r: Renderer;
  private readonly judge: Judge;
  private readonly scroller: Scroller;
  private readonly info: SceneInfo;
  private readonly tracks: number;
  private readonly words: Sprite[];

  // Per note: where scroll segments put it, and its colour.
  private readonly displayBeat: Float64Array;
  private readonly displayEndBeat: Float64Array;
  private readonly quant: Uint8Array;
  /** For a hold let go: where its top stays. */
  private readonly clipBeat: Float64Array;
  private drawFrom = 0;

  // Per track: flashes, by frame clock (ms).
  private readonly flashAt: Float64Array;
  private readonly flashScore: Uint8Array;
  private readonly mineAt: Float64Array;
  private readonly holdAt: Float64Array;
  private readonly holdScore: Uint8Array;
  /** A hold being held on this track right now (set while drawing). */
  private readonly holding: Uint8Array;

  private judgmentAt = -Infinity;
  private judgmentScore = 0;
  private judgmentOffset = 0;
  private anyMineAt = -Infinity;
  private failedAt = -Infinity;
  private comboShown = 0;
  private comboAt = -Infinity;
  /** The worst row judgement so far: the colour of the combo. */
  private worst: number = TNS.W1;
  private finishedAt = -Infinity;
  private clock = 0;

  // Sparks thrown by good hits: a fixed pool, reused in turn.
  private readonly pX = new Float32Array(PARTICLES);
  private readonly pY = new Float32Array(PARTICLES);
  private readonly pVx = new Float32Array(PARTICLES);
  private readonly pVy = new Float32Array(PARTICLES);
  private readonly pBorn = new Float64Array(PARTICLES).fill(-Infinity);
  private readonly pScore = new Uint8Array(PARTICLES);
  private pNext = 0;
  private pSeed = 1234567;

  constructor(renderer: Renderer, judge: Judge, scroller: Scroller, info: SceneInfo) {
    this.r = renderer;
    this.judge = judge;
    this.scroller = scroller;
    this.info = info;
    this.tracks = judge.numTracks;
    const w = renderer.atlas.words;
    // By TapNoteScore.
    this.words = [w.Miss, w.Miss, w.Miss, w.Miss, w.Miss, w.Boo, w.Good, w.Great, w.Perfect, w.Flawless, w.Flawless];
    const n = judge.count;
    this.displayBeat = new Float64Array(n);
    this.displayEndBeat = new Float64Array(n);
    this.quant = new Uint8Array(n);
    this.clipBeat = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      this.displayBeat[i] = scroller.displayBeatOfRow(judge.row[i]!);
      this.displayEndBeat[i] = scroller.displayBeatOfRow(judge.endRow[i]!);
      this.quant[i] = quantisation(judge.row[i]!);
    }
    this.flashAt = new Float64Array(this.tracks).fill(-Infinity);
    this.flashScore = new Uint8Array(this.tracks);
    this.mineAt = new Float64Array(this.tracks).fill(-Infinity);
    this.holdAt = new Float64Array(this.tracks).fill(-Infinity);
    this.holdScore = new Uint8Array(this.tracks);
    this.holding = new Uint8Array(this.tracks);
  }

  /** Give this to Judge.onEvent. */
  readonly onJudgeEvent = (kind: number, seconds: number, track: number, value: number, offset: number, note: number): void => {
    const now = this.clock;
    if (kind === EV_TAP_JUDGMENT) {
      this.judgmentAt = now;
      this.judgmentScore = value;
      this.judgmentOffset = offset;
      if (value < this.worst) this.worst = value;
    } else if (kind === EV_GHOST) {
      this.flashAt[track] = now;
      this.flashScore[track] = value;
      if (value >= TNS.W3) this.burst(track, value, now);
    } else if (kind === EV_MINE_HIT) {
      this.mineAt[track] = now;
      this.anyMineAt = now;
    } else if (kind === EV_HOLD_JUDGMENT) {
      if (value === HNS.Missed) return;
      this.holdAt[track] = now;
      this.holdScore[track] = value;
      if (value === HNS.LetGo) {
        this.clipBeat[note] = this.scroller.displayBeatAtSeconds(seconds);
        this.worst = TNS.Miss;
      } else {
        this.flashAt[track] = now;
        this.flashScore[track] = TNS.W1;
        this.burst(track, TNS.W1, now);
      }
    } else if (kind === EV_FAILED) {
      this.failedAt = now;
    }
  };

  /** Throws sparks from a track's receptor. */
  private burst(track: number, score: number, now: number): void {
    const x = columnX(track, this.tracks);
    const y = this.scroller.receptorY;
    for (let k = 0; k < PARTICLES_PER_HIT; k++) {
      const i = this.pNext;
      this.pNext = (i + 1) % PARTICLES;
      this.pSeed = (this.pSeed * 1103515245 + 12345) & 0x7fffffff;
      const angle = (this.pSeed / 0x7fffffff) * Math.PI * 2;
      this.pSeed = (this.pSeed * 1103515245 + 12345) & 0x7fffffff;
      const speed = 90 + (this.pSeed / 0x7fffffff) * 170;
      this.pX[i] = x;
      this.pY[i] = y;
      this.pVx[i] = Math.cos(angle) * speed;
      this.pVy[i] = Math.sin(angle) * speed - 50;
      this.pBorn[i] = now;
      this.pScore[i] = score;
    }
  }

  /** Sets the frame clock (ms) that events arriving from now on are stamped with. */
  setClock(frameMs: number): void {
    this.clock = frameMs;
  }

  /** Draws the frame for music time `musicSeconds`. */
  draw(musicSeconds: number, frameMs: number): void {
    const r = this.r;
    const judge = this.judge;
    const scroller = this.scroller;
    const atlas = r.atlas;
    const tracks = this.tracks;
    this.clock = frameMs;
    scroller.update(musicSeconds);
    const receptorY = scroller.receptorY;
    const down = scroller.options.reverse ? -1 : 1;
    const viewW = r.viewWidth;
    const halfW = viewW / 2;
    const halfH = SCREEN_HEIGHT / 2;
    const laneHalf = (tracks * ARROW_SIZE) / 2 + 12;
    // 1 on the beat, falling away after it.
    const beatPhase = scroller.songBeat - Math.floor(scroller.songBeat);
    const pulse = musicSeconds >= this.info.firstSeconds - 2 ? (1 - beatPhase) * (1 - beatPhase) : 0;

    const keeper = judge.keeper;
    const centre = receptorY * -0.12;

    r.begin();

    // ------------------------------------------------------------ backdrop
    if (!r.hasBackground) {
      // No picture: slow lights.
      const t = frameMs / 1000;
      const size = 760;
      r.sprite(atlas.glow, Math.cos(t * 0.11) * halfW * 0.6, Math.sin(t * 0.17) * 120, size, size, 0, 0.1, 0.25, 0.9, 0.38, true);
      r.sprite(atlas.glow, Math.cos(t * 0.13 + 2.1) * halfW * 0.7, Math.sin(t * 0.09 + 1.3) * 150, size, size, 0, 0.6, 0.12, 0.8, 0.32, true);
      r.sprite(atlas.glow, Math.cos(t * 0.07 + 4.2) * halfW * 0.5, Math.sin(t * 0.15 + 3.1) * 130, size, size, 0, 0.05, 0.6, 0.6, 0.26 + 0.08 * pulse, true);
    }
    r.sprite(atlas.vignette, 0, 0, viewW * 1.25, SCREEN_HEIGHT * 1.25, 0, 1, 1, 1, 0.85);

    // ---------------------------------------------------------------- lanes
    r.rect(-laneHalf, -halfH, laneHalf, halfH, 0.01, 0.015, 0.03, 0.72);
    r.rect(-laneHalf - 1.5, -halfH, -laneHalf, halfH, 0.6, 0.7, 0.9, 0.22);
    r.rect(laneHalf, -halfH, laneHalf + 1.5, halfH, 0.6, 0.7, 0.9, 0.22);
    // A band of light across the targets, breathing with the beat.
    r.sprite(atlas.glow, 0, receptorY, laneHalf * 2.4, 130, 0, 0.35, 0.55, 1, 0.1 + 0.16 * pulse, true);

    // ------------------------------------------------------------ receptors
    for (let t = 0; t < tracks; t++) {
      const x = columnX(t, tracks);
      const pressed = judge.pressed[t] === 1;
      const size = pressed ? ARROW_SIZE * 0.9 : ARROW_SIZE;
      const lit = (pressed ? 1 : 0.72) + 0.28 * pulse;
      if (pressed) r.sprite(atlas.glow, x, receptorY, ARROW_SIZE * 1.7, ARROW_SIZE * 1.7, 0, 0.5, 0.75, 1, 0.5, true);
      r.sprite(atlas.receptor, x, receptorY, size, size, ANGLE[t % 4]!, lit, lit, lit, 1);
    }

    // ------------------------------------------------- judgement and combo
    // Under the notes, which pass over them.
    let age = (frameMs - this.judgmentAt) / JUDGMENT_MS;
    if (age >= 0 && age < 1) {
      const s = this.judgmentScore;
      const pop = age < 0.14 ? 1.35 - (age / 0.14) * 0.35 : 1;
      const alpha = age < 0.72 ? 1 : (1 - age) / 0.28;
      r.text(this.words[s]!, 0, centre - 34, 40 * pop, 1, 1, 1, alpha);
      if (s !== TNS.Miss && s < TNS.W1) {
        const early = this.judgmentOffset < 0;
        r.text(early ? atlas.words.Early : atlas.words.Late, 0, centre - 8, 12, early ? 0.5 : 1, early ? 0.8 : 0.62, early ? 1 : 0.4, alpha * 0.9);
      }
    }
    const combo = keeper.curCombo >= SHOW_COMBO_AT ? keeper.curCombo : keeper.curMissCombo >= SHOW_COMBO_AT ? -keeper.curMissCombo : 0;
    if (combo !== this.comboShown) {
      this.comboShown = combo;
      this.comboAt = frameMs;
    }
    if (combo !== 0) {
      const popAge = clamp01((frameMs - this.comboAt) / COMBO_POP_MS);
      const pop = 1 + 0.22 * (1 - popAge);
      if (combo > 0) {
        const w = this.worst;
        const cr = w >= TNS.W1 ? 0.72 : w >= TNS.W2 ? 1 : w >= TNS.W3 ? 0.55 : 1;
        const cg = w >= TNS.W1 ? 0.95 : w >= TNS.W2 ? 0.9 : 1;
        const cb = w >= TNS.W1 ? 1 : w >= TNS.W2 ? 0.45 : w >= TNS.W3 ? 0.6 : 1;
        r.number(combo, 0, centre + 30, 52 * pop, cr, cg, cb, 1);
        r.text(atlas.words.Combo, 0, centre + 62, 13, 0.82, 0.86, 0.95, 1);
      } else {
        r.number(-combo, 0, centre + 30, 52 * pop, 1, 0.28, 0.28, 1);
        r.text(atlas.words.Misses, 0, centre + 62, 13, 1, 0.5, 0.5, 1);
      }
    }

    // The notes to look at: from the first that may still show to the last that is near.
    const n = judge.count;
    while (this.drawFrom < n && judge.endSeconds[this.drawFrom]! < musicSeconds - KEEP_SECONDS) this.drawFrom++;
    let to = this.drawFrom;
    const limit = Math.min(n, this.drawFrom + MAX_NOTES_PER_FRAME);
    while (to < limit && judge.seconds[to]! <= musicSeconds + AHEAD_SECONDS) to++;

    // ---------------------------------------------------------------- holds
    // First, so that taps lie on top; later notes first, so that nearer ones do.
    this.holding.fill(0);
    for (let i = to - 1; i >= this.drawFrom; i--) {
      if (judge.type[i] !== NOTE_HOLD_HEAD) continue;
      const hns = judge.hns[i]!;
      if (hns === HNS.Held) continue;
      const tns = judge.tns[i]!;
      let top = scroller.yOffset(this.displayBeat[i]!, judge.seconds[i]!);
      let bottom = scroller.yOffset(this.displayEndBeat[i]!, judge.endSeconds[i]!);
      const stepped = tns >= TNS.W5;
      let level = 0.82;
      let dead = false;
      if (hns === HNS.LetGo) {
        // The part let go of scrolls away from where it was dropped.
        top = Math.max(top, scroller.yOffset(this.clipBeat[i]!, judge.letGoSeconds[i]!));
        dead = true;
      } else if (hns === HNS.Missed || tns === TNS.Miss) {
        dead = true;
      } else if (stepped) {
        top = Math.max(top, 0); // the head waits on the receptor while the hold lasts
      }
      if (bottom < top) bottom = top;
      if (bottom < DRAW_DISTANCE_AFTER || top > DRAW_DISTANCE_BEFORE) continue;
      const t = judge.track[i]!;
      const x = columnX(t, tracks);
      const roll = judge.roll[i] === 1;
      const active = stepped && hns === HNS.None && top === 0;
      if (active) {
        this.holding[t] = 1;
        level = 1;
      }
      let cr = roll ? 1.0 : 0.2;
      let cg = roll ? 0.5 : 0.85;
      let cb = roll ? 0.12 : 1.0;
      if (dead) {
        cr = cg = cb = 0.32;
        level = 1;
      }
      const y0 = scroller.yPos(top);
      const y1 = scroller.yPos(Math.min(bottom, DRAW_DISTANCE_BEFORE + ARROW_SIZE));
      r.sprite(atlas.holdBody, x, (y0 + y1) / 2, HOLD_WIDTH, Math.abs(y1 - y0) + 0.5, 0, cr * level, cg * level, cb * level, 1);
      r.sprite(atlas.holdCap, x, y1 + (down * HOLD_WIDTH) / 4, HOLD_WIDTH, HOLD_WIDTH / 2, down > 0 ? 0 : Math.PI, cr * level, cg * level, cb * level, 1);
      if (active) {
        // A core of light while it is held.
        const flicker = 0.35 + 0.15 * Math.sin(frameMs * 0.05);
        r.sprite(atlas.solid, x, (y0 + y1) / 2, HOLD_WIDTH * 0.3, Math.abs(y1 - y0), 0, 1, 1, 1, flicker, true);
      }
      const q = this.quant[i]!;
      const dim = dead ? 0.4 : 1;
      r.sprite(atlas.arrowFill, x, y0, ARROW_SIZE, ARROW_SIZE, ANGLE[t % 4]!, QUANT_R[q]! * dim, QUANT_G[q]! * dim, QUANT_B[q]! * dim, 1);
      r.sprite(atlas.arrowOver, x, y0, ARROW_SIZE, ARROW_SIZE, ANGLE[t % 4]!, dim, dim, dim, 1);
    }

    // ---------------------------------------------------------------- notes
    const spin = frameMs * 0.0025;
    for (let i = to - 1; i >= this.drawFrom; i--) {
      const type = judge.type[i]!;
      if (type === NOTE_HOLD_HEAD || type === NOTE_AUTO_KEYSOUND || judge.hidden[i]) continue;
      const offset = scroller.yOffset(this.displayBeat[i]!, judge.seconds[i]!);
      if (offset < DRAW_DISTANCE_AFTER || offset > DRAW_DISTANCE_BEFORE) continue;
      const t = judge.track[i]!;
      const x = columnX(t, tracks);
      const y = scroller.yPos(offset);
      if (type === NOTE_MINE) {
        r.sprite(atlas.glow, x, y, ARROW_SIZE * 1.3, ARROW_SIZE * 1.3, 0, 1, 0.15, 0.1, 0.35 + 0.25 * pulse, true);
        r.sprite(atlas.mine, x, y, ARROW_SIZE * 0.86, ARROW_SIZE * 0.86, spin, 1, 1, 1, 1);
        continue;
      }
      const q = this.quant[i]!;
      const dim = judge.tns[i] === TNS.Miss ? 0.4 : 1;
      const alpha = type === NOTE_FAKE || !judge.judgable[i] ? 0.5 : 1;
      const angle = ANGLE[t % 4]!;
      if (type === NOTE_LIFT) {
        r.sprite(atlas.arrowFill, x, y, ARROW_SIZE, ARROW_SIZE, angle, 0.8 * dim, 0.84 * dim, 0.9 * dim, alpha);
        r.sprite(atlas.arrowOver, x, y, ARROW_SIZE, ARROW_SIZE, angle, dim, dim, dim, alpha);
        r.sprite(atlas.arrowFill, x, y, ARROW_SIZE * 0.45, ARROW_SIZE * 0.45, angle, QUANT_R[q]! * dim, QUANT_G[q]! * dim, QUANT_B[q]! * dim, alpha);
      } else {
        r.sprite(atlas.arrowFill, x, y, ARROW_SIZE, ARROW_SIZE, angle, QUANT_R[q]! * dim, QUANT_G[q]! * dim, QUANT_B[q]! * dim, alpha);
        r.sprite(atlas.arrowOver, x, y, ARROW_SIZE, ARROW_SIZE, angle, dim, dim, dim, alpha);
      }
    }

    // --------------------------------------------- light on the receptors
    for (let t = 0; t < tracks; t++) {
      const x = columnX(t, tracks);
      if (this.holding[t]) {
        const flicker = 0.5 + 0.2 * Math.sin(frameMs * 0.06 + t);
        r.sprite(atlas.glow, x, receptorY, ARROW_SIZE * 2, ARROW_SIZE * 2, 0, 0.7, 0.9, 1, flicker, true);
      }
      let age = (frameMs - this.flashAt[t]!) / FLASH_MS;
      if (age >= 0 && age < 1) {
        const s = this.flashScore[t]!;
        const out = 1 - age;
        const strong = s >= TNS.W3 ? 1 : 0.5;
        const grow = 1 + age * 0.75;
        r.sprite(atlas.arrowFlash, x, receptorY, ARROW_SIZE * 1.15 * grow, ARROW_SIZE * 1.15 * grow, ANGLE[t % 4]!, HIT_R[s]!, HIT_G[s]!, HIT_B[s]!, out * out * strong, true);
        r.sprite(atlas.ring, x, receptorY, ARROW_SIZE * (0.9 + age * 1.5), ARROW_SIZE * (0.9 + age * 1.5), 0, HIT_R[s]!, HIT_G[s]!, HIT_B[s]!, out * 0.8 * strong, true);
        r.sprite(atlas.glow, x, receptorY, ARROW_SIZE * 2.4, ARROW_SIZE * 2.4, 0, HIT_R[s]!, HIT_G[s]!, HIT_B[s]!, out * out * 0.7 * strong, true);
      }
      age = (frameMs - this.mineAt[t]!) / MINE_MS;
      if (age >= 0 && age < 1) {
        const out = 1 - age;
        r.sprite(atlas.glow, x, receptorY, ARROW_SIZE * (2.5 + age * 3), ARROW_SIZE * (2.5 + age * 3), 0, 1, 0.35, 0.08, out, true);
        r.sprite(atlas.ring, x, receptorY, ARROW_SIZE * (1 + age * 3.2), ARROW_SIZE * (1 + age * 3.2), 0, 1, 0.6, 0.2, out * out, true);
      }
      age = (frameMs - this.holdAt[t]!) / HOLD_JUDGMENT_MS;
      if (age >= 0 && age < 1) {
        const held = this.holdScore[t] === HNS.Held;
        const rise = down * (58 + age * 8);
        r.text(held ? atlas.words.OK : atlas.words.NG, x, receptorY + rise, 20, held ? 0.45 : 1, held ? 1 : 0.3, held ? 0.55 : 0.3, age < 0.65 ? 1 : (1 - age) / 0.35);
      }
    }

    // Sparks: fly out, fall a little, fade.
    for (let i = 0; i < PARTICLES; i++) {
      const a = (frameMs - this.pBorn[i]!) / 1000;
      if (a < 0 || a >= PARTICLE_SECONDS) continue;
      const out = 1 - a / PARTICLE_SECONDS;
      const sc = this.pScore[i]!;
      const size = 4 + 10 * out;
      r.sprite(atlas.glow, this.pX[i]! + this.pVx[i]! * a, this.pY[i]! + this.pVy[i]! * a + 260 * a * a, size, size, 0, HIT_R[sc]!, HIT_G[sc]!, HIT_B[sc]!, out, true);
    }

    // A word before the first note, and at the end of a clean run.
    const untilFirst = this.info.firstSeconds - musicSeconds;
    if (untilFirst > 0.35 && untilFirst < 2.6) {
      const a = clamp01((2.6 - untilFirst) / 0.3) * clamp01((untilFirst - 0.35) / 0.3);
      r.text(atlas.words.Ready, 0, centre, 38, 1, 1, 1, a);
    }
    if (judge.finished && this.finishedAt === -Infinity) this.finishedAt = frameMs;
    if (this.finishedAt !== -Infinity && !judge.life.failed && keeper.numTapsAndHolds > 0 && keeper.fullComboOfScore(TNS.W3)) {
      const a = clamp01((frameMs - this.finishedAt) / 250);
      r.sprite(atlas.glow, 0, centre - 80, 520, 120, 0, 1, 0.8, 0.3, 0.5 * a, true);
      r.text(atlas.words['Full Combo'], 0, centre - 80, 46 * (1.3 - 0.3 * a), 1, 1, 1, a);
    }

    // ------------------------------------------------------------------ HUD
    const top = -halfH;
    // Song progress along the very top.
    const span = this.info.lastSeconds - this.info.firstSeconds;
    const progress = span > 0 ? clamp01((musicSeconds - this.info.firstSeconds) / span) : 0;
    r.rect(-halfW, top, halfW, top + 3, 1, 1, 1, 0.12);
    r.rect(-halfW, top, -halfW + viewW * progress, top + 3, this.info.level[0], this.info.level[1], this.info.level[2], 0.95);

    // Life.
    const life = judge.life.life;
    const barW = 2 * laneHalf - 70;
    const barX = -laneHalf + 6;
    const barY = top + 20;
    r.rect(barX - 2, barY - 8, barX + barW + 2, barY + 8, 0.02, 0.03, 0.05, 0.9);
    r.rect(barX - 2, barY - 8, barX + barW + 2, barY - 7, 1, 1, 1, 0.25);
    if (life > 0) {
      const hot = judge.life.isHot;
      const danger = life < LIFE_DANGER;
      const blink = danger ? 0.65 + 0.35 * Math.sin(frameMs * 0.02) : 1;
      const lr = danger ? 1 : hot ? 1 : 0.25;
      const lg = danger ? 0.2 : hot ? 0.92 + 0.08 * pulse : 0.8;
      const lb = danger ? 0.2 : hot ? 0.55 + 0.3 * pulse : 1;
      const len = barW * life;
      r.sprite(atlas.holdBody, barX + len / 2, barY, 12, len, HALF_PI, lr * blink, lg * blink, lb * blink, 1);
      r.sprite(atlas.glow, barX + len, barY, 34, 34, 0, lr, lg, lb, hot ? 0.5 + 0.4 * pulse : 0.6, true);
    }
    this.percent(keeper.percentDancePoints(), laneHalf - 30, barY, 17);

    // The song, at the left, where there is room for it.
    if (halfW - laneHalf > 190) {
      const left = -halfW + 18;
      const level = this.info.level;
      r.rect(left, top + 16, left + 3, top + 62, level[0], level[1], level[2], 1);
      this.textLeft(atlas.title, left + 10, top + 26, 21, 1, 1, 1, 1);
      this.textLeft(atlas.artist, left + 10, top + 43, 13, 0.7, 0.75, 0.85, 1);
      this.textLeft(atlas.level, left + 10, top + 57, 12, level[0], level[1], level[2], 1);
    }
    // The count of each judgement, at the right.
    if (halfW - laneHalf > 190) {
      const x0 = laneHalf + 26;
      const x1 = Math.min(halfW - 18, x0 + 150);
      let y = top + 96;
      for (let tns = TNS.W1; tns >= TNS.Miss; tns--) {
        this.textLeft(this.words[tns]!, x0, y, 13, 1, 1, 1, 0.95);
        this.numberRight(keeper.tapNoteScores[tns]!, x1, y, 15);
        y += 21;
      }
      r.rect(x0, y - 6, x1, y - 5, 1, 1, 1, 0.14);
      y += 8;
      this.textLeft(atlas.words.OK, x0, y, 13, 0.45, 1, 0.55, 0.95);
      this.numberRight(keeper.holdNoteScores[HNS.Held]!, x1, y, 15);
      y += 21;
      this.textLeft(atlas.words.Combo, x0, y, 13, 0.82, 0.86, 0.95, 0.95);
      this.numberRight(keeper.maxCombo, x1, y, 15);
    }
    if (judge.autoplay) r.text(atlas.words.Autoplay, 0, halfH - 14, 12, 0.55, 0.78, 1, 0.9);

    // A mine going off, and failing, colour the whole screen.
    age = (frameMs - this.anyMineAt) / MINE_MS;
    if (age >= 0 && age < 1) r.rect(-halfW, -halfH, halfW, halfH, 1, 0.2, 0.05, 0.16 * (1 - age));
    if (judge.life.failed) {
      // Said once, then out of the way: the player may want to play on.
      const since = frameMs - this.failedAt;
      const fade = clamp01(since / 400);
      const show = fade * clamp01((2400 - since) / 600);
      if (show > 0) {
        r.rect(-halfW, -halfH, halfW, halfH, 0.35, 0, 0, 0.3 * show);
        r.text(atlas.words.Failed, 0, centre - 90, 54 * (1.4 - 0.4 * fade), 1, 1, 1, show);
      }
      r.text(atlas.words.Failed, 0, halfH - 30, 13, 1, 1, 1, 0.75 * (1 - show));
    }

    r.end();
  }

  /** A label whose left edge is at `x`. */
  private textLeft(s: Sprite, x: number, cy: number, height: number, r: number, g: number, b: number, a: number): void {
    this.r.text(s, x + (height * s.aspect) / 2 - height * 0.11, cy, height, r, g, b, a);
  }

  /** A whole number whose right edge is at `x`. */
  private numberRight(value: number, x: number, cy: number, height: number): void {
    const advance = height * this.r.atlas.digits[0]!.aspect * 0.66;
    let count = 1;
    for (let m = value; m >= 10; m = Math.floor(m / 10)) count++;
    this.r.number(value, x - (count * advance) / 2, cy, height, 1, 1, 1, 1);
  }

  /** "97.53%" with its right edge at `right`. `fraction` is 0..1 in steps of 0.0001. */
  private percent(fraction: number, right: number, cy: number, h: number): void {
    const r = this.r;
    const atlas = r.atlas;
    const hundredths = Math.round(fraction * 10000);
    const whole = Math.floor(hundredths / 100);
    const part = hundredths % 100;
    const advance = h * atlas.digits[0]!.aspect * 0.66;
    let x = right + 62;
    r.text(atlas.percent, x, cy, h * 0.8, 0.8, 0.86, 0.95, 1);
    x -= advance * 1.15;
    r.text(atlas.digits[part % 10]!, x, cy, h, 1, 1, 1, 1);
    x -= advance;
    r.text(atlas.digits[Math.floor(part / 10)]!, x, cy, h, 1, 1, 1, 1);
    x -= advance * 0.62;
    r.text(atlas.dot, x, cy, h, 1, 1, 1, 1);
    const count = whole >= 100 ? 3 : whole >= 10 ? 2 : 1;
    x -= advance * 0.62 + ((count - 1) * advance) / 2;
    r.number(whole, x, cy, h, 1, 1, 1, 1);
  }
}
