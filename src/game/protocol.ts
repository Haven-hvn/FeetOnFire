// Messages between the page and the game worker, and the layout of the input ring.

import type { SimfileFormat } from '../chart/index.ts';
import type { ScrollOptions } from './field.ts';

/** Input ring record: kind, track, down (1/0), timestamp (ms, main-thread performance clock). */
export const INPUT_FIELDS = 4;
export const INPUT_KEY = 1;
export const INPUT_HID = 2;
export const INPUT_PAD = 3;
/** A touch pad press, straight on a panel with no binding. */
export const INPUT_TOUCH = 4;
/** Written by a test instead of a key event. */
export const INPUT_INJECTED = 9;
export const INPUT_RING_CAPACITY = 1024;

export interface PlaySettings {
  autoplay: boolean;
  scroll: ScrollOptions;
  failType: 'immediate' | 'off';
  /**
   * Added to the music time being heard, ms, as StepMania's GlobalOffsetSeconds is: negative
   * makes the notes come later. Set by hand until the calibration screen exists; it stands
   * for output latency the browser does not report.
   */
  globalOffsetMs: number;
  /** Draw the field for this much later than the frame's own time (display latency), ms. */
  visualLeadMs: number;
  /**
   * How far behind the present the clock-driven judging (misses, hold results) is kept, ms:
   * more than the longest an input takes to reach the worker, so that inputs arrive in time
   * order. Hits are judged at their own timestamps whatever this is.
   */
  judgeLagMs: number;
  /** Keep every input and judgement for the report (tests). */
  log: boolean;
}

export const DEFAULT_SETTINGS: PlaySettings = {
  autoplay: false,
  scroll: { mode: 'x', value: 1, reverse: false },
  failType: 'immediate',
  globalOffsetMs: 0,
  visualLeadMs: 0,
  judgeLagMs: 40,
  log: false,
};

export interface InitMessage {
  type: 'init';
  canvas: OffscreenCanvas;
  /** performance.timeOrigin of the page. */
  mainOrigin: number;
  mode: 'shared' | 'messages';
  ring?: SharedArrayBuffer;
  clock?: SharedArrayBuffer;
  /** Where the page writes its clock for the offset measurement. */
  probe?: SharedArrayBuffer;
  simfile: Uint8Array;
  format: SimfileFormat;
  path: string;
  chartIndex: number;
  settings: PlaySettings;
}

export type ToWorker =
  | InitMessage
  | { type: 'input'; record: number[] }
  | { type: 'clock'; fitPerf: number; fitContext: number; fitSlope: number; musicOffsetSeconds: number | null }
  | { type: 'clock-sync-reply'; workerNow: number; receivedPageNow: number; pageNow: number }
  | { type: 'resize'; width: number; height: number }
  | { type: 'background'; bitmap: ImageBitmap; dim: number }
  | { type: 'report' }
  | { type: 'stop' };

export interface Results {
  /** Rows per judgement. */
  w1: number;
  w2: number;
  w3: number;
  w4: number;
  w5: number;
  miss: number;
  minesHit: number;
  held: number;
  letGo: number;
  missedHolds: number;
  /** What the chart holds: rows with a step, holds, rolls. */
  rows: number;
  holds: number;
  rolls: number;
  actualDancePoints: number;
  possibleDancePoints: number;
  /** 0..100, two decimals, cut not rounded. */
  percent: number;
  score: number;
  maxCombo: number;
  grade: string;
  failed: boolean;
  life: number;
  autoplay: boolean;
  /** True when every note has been judged. */
  complete: boolean;
}

export interface Telemetry {
  frames: number;
  canvas: { width: number; height: number };
  renderer: string;
  refreshHz: number | null;
  frameIntervalMs: unknown;
  /** Frames that took more than 1.5 times the usual interval to come. */
  lateFrames: number;
  onTimePercent: number | null;
  rafCallbackDelayMs: unknown;
  frameCpuMs: unknown;
  /** Input timestamp to the end of the first frame drawn with it (T2 to T6). */
  inputToFrameMs: unknown;
  inputs: number;
  /** Inputs that reached the worker after judging had passed their time. */
  lateInputs: number;
  ringDropped: number;
  quadsDropped: number;
  /** This worker's clock against the page's: what the timeOrigin conversion was off by. */
  clockOffsetErrorMs: number | null;
  clockOffsetSamples: number;
}

export interface ReportLog {
  /** Per input: timestamp ms, music seconds, track, down. */
  inputs: number[][];
  /** Per judge event: kind, music seconds, track, value, offset seconds. */
  events: number[][];
}

export type FromWorker =
  | { type: 'clock-ready' }
  | { type: 'clock-sync'; workerNow: number }
  | { type: 'ready'; title: string; notes: number; firstSeconds: number; lastSeconds: number; tracks: number }
  | { type: 'error'; message: string }
  | { type: 'mine' }
  | { type: 'finished'; results: Results }
  | { type: 'report'; results: Results; telemetry: Telemetry; log: ReportLog | null };
