// The game worker: judges and draws. One frame, driven by requestAnimationFrame:
//
//   1. take the clock map the page published (shared memory);
//   2. drain the input ring: each input is judged at the music time of its own timestamp;
//   3. let the judge's clock run up to a little behind the present;
//   4. draw the field for the frame's time.
//
// The page keeps the audio engine and the input listeners; nothing here waits on it.

import { loadChartNotes, parseSimfile } from '../chart/index.ts';
import { toMainTime } from '../shared/clock.ts';
import { EventRing } from '../shared/ring.ts';
import { Series, round, roundSummary, summarize } from '../shared/stats.ts';
import { GRADE_NAMES, HNS, TNS } from './constants.ts';
import { readBpm, Scroller } from './field.ts';
import { EV_MINE_HIT, Judge } from './judge.ts';
import { INPUT_FIELDS, type FromWorker, type InitMessage, type PlaySettings, type ReportLog, type Results, type Telemetry, type ToWorker } from './protocol.ts';
import { Renderer } from './render.ts';
import { Scene } from './scene.ts';
import { SharedClock } from './shared-clock.ts';

interface WorkerScope {
  onmessage: ((e: MessageEvent) => void) | null;
  postMessage(message: FromWorker): void;
  requestAnimationFrame(callback: (time: number) => void): number;
  cancelAnimationFrame(handle: number): void;
  setTimeout(callback: () => void, ms?: number): number;
}

interface InputSource {
  pop(out: Float64Array): boolean;
  readonly dropped: number;
}

class MessageInput implements InputSource {
  private readonly queue: number[][] = [];
  dropped = 0;
  push(record: number[]): void {
    if (this.queue.length >= 4096) {
      this.queue.shift();
      this.dropped++;
    }
    this.queue.push(record);
  }
  pop(out: Float64Array): boolean {
    const record = this.queue.shift();
    if (!record) return false;
    for (let i = 0; i < INPUT_FIELDS; i++) out[i] = record[i] ?? 0;
    return true;
  }
}

const scope = globalThis as unknown as WorkerScope;

const LEVEL_COLOURS: Record<string, [number, number, number]> = {
  Beginner: [0.22, 0.78, 0.85],
  Easy: [0.37, 0.83, 0.37],
  Medium: [0.95, 0.79, 0.3],
  Hard: [0.95, 0.4, 0.3],
  Challenge: [0.7, 0.42, 0.95],
  Edit: [0.6, 0.64, 0.7],
};

const LOG_INPUTS = 8192;
const LOG_EVENTS = 16384;
/** How long after the last judgement the song counts as over. */
const END_SECONDS = 1.0;

let renderer: Renderer | null = null;
let judge: Judge | null = null;
let scene: Scene | null = null;
let inputSource: InputSource | null = null;
let messageInput: MessageInput | null = null;
let clock: SharedClock | null = null;
let settings: PlaySettings | null = null;
let running = false;
let messageMode = false;
let syncCount = 0;
let syncSum = 0;
let initialToMain = 0;
const SYNC_SAMPLES = 8;
let raf = 0;
/** Add to this worker's performance.now() to get the page's. */
let toMain = 0;
let clockOffsetError: number | null = null;
let clockOffsetSamples = 0;
/** Music time shown before the music starts. */
let idleSeconds = 0;
/** PlaySettings.globalOffsetMs in seconds. */
let globalOffset = 0;
let finishedSent = false;

let frames = 0;
let lastTs = -1;
let inputs = 0;
let lateInputs = 0;
// Sized so that they do not grow during a song.
const intervals = new Series(1 << 17);
const callbackDelay = new Series(1 << 17);
const cpu = new Series(1 << 17);
const inputToFrame = new Series(1 << 15);
const rec = new Float64Array(INPUT_FIELDS);
// Timestamps of the inputs taken in the current frame.
const frameStamps = new Float64Array(64);
let frameStampCount = 0;

let inputLog: Float64Array | null = null;
let inputLogCount = 0;
let eventLog: Float64Array | null = null;
let eventLogCount = 0;

/**
 * This thread's clock against the page's. The page writes its performance.now() into shared
 * memory in a tight loop; each time the value changes, (our converted time - the value) is
 * the read delay plus what the timeOrigin conversion is off by. The smallest is the error.
 */
function measureClock(probe: SharedArrayBuffer, mainOrigin: number): void {
  const view = new Float64Array(probe);
  let best = Infinity;
  let samples = 0;
  let last = view[0]!;
  const start = performance.now();
  let lastChange = start;
  scope.postMessage({ type: 'clock-ready' });
  for (;;) {
    const v = view[0]!;
    const local = performance.now();
    if (v !== last) {
      last = v;
      lastChange = local;
      const diff = toMainTime(local, performance.timeOrigin, mainOrigin) - v;
      if (diff < best) best = diff;
      samples++;
    }
    if (local - start > 400) break;
    if (samples > 0 && local - lastChange > 15) break;
  }
  clockOffsetSamples = samples;
  if (samples > 0) {
    clockOffsetError = best;
    toMain -= best;
  }
}

function startClockSync(): void {
  let sent = 0;
  const tick = (): void => {
    if (sent >= SYNC_SAMPLES) return;
    sent++;
    scope.postMessage({ type: 'clock-sync', workerNow: performance.now() });
    scope.setTimeout(tick, 30);
  };
  scope.setTimeout(tick, 50);
}

function init(msg: InitMessage): void {
  settings = msg.settings;
  globalOffset = settings.globalOffsetMs / 1000;
  toMain = performance.timeOrigin - msg.mainOrigin;
  const simfile = parseSimfile(msg.simfile, msg.format, { path: msg.path });
  const chart = simfile.charts[msg.chartIndex];
  if (!chart) throw new Error(`The file has no chart ${msg.chartIndex}`);
  const title = simfile.subtitle ? `${simfile.title} ${simfile.subtitle}` : simfile.title;
  renderer = new Renderer(msg.canvas, { title, artist: simfile.artist, level: `${chart.difficulty ?? 'Edit'} ${chart.meter}` });
  const loaded = loadChartNotes(chart);
  judge = new Judge(loaded.notes, chart.timing, chart.tracks, { autoplay: settings.autoplay, failType: settings.failType });
  const scroller = new Scroller(chart.timing, settings.scroll, readBpm(chart));
  const first = loaded.notes.length > 0 ? loaded.notes[0]!.seconds : 0;
  scene = new Scene(renderer, judge, scroller, { firstSeconds: first, lastSeconds: judge.lastJudgementSeconds, level: LEVEL_COLOURS[chart.difficulty ?? 'Edit'] ?? LEVEL_COLOURS.Edit! });

  if (settings.log) {
    inputLog = new Float64Array(LOG_INPUTS * 4);
    eventLog = new Float64Array(LOG_EVENTS * 5);
  }
  const sceneEvent = scene.onJudgeEvent;
  judge.onEvent = (kind, seconds, track, value, offset, note) => {
    sceneEvent(kind, seconds, track, value, offset, note);
    if (kind === EV_MINE_HIT) scope.postMessage({ type: 'mine' });
    if (eventLog && eventLogCount < LOG_EVENTS) {
      const o = eventLogCount++ * 5;
      eventLog[o] = kind;
      eventLog[o + 1] = seconds;
      eventLog[o + 2] = track;
      eventLog[o + 3] = value;
      eventLog[o + 4] = offset;
    }
  };

  messageMode = msg.mode === 'messages';
  initialToMain = toMain;
  if (messageMode) {
    messageInput = new MessageInput();
    inputSource = messageInput;
    clock = new SharedClock(SharedClock.allocate());
  } else {
    messageInput = null;
    if (!msg.ring || !msg.clock || !msg.probe) throw new Error('shared game buffers missing');
    inputSource = new EventRing(msg.ring, INPUT_FIELDS);
    clock = new SharedClock(msg.clock);
    measureClock(msg.probe, msg.mainOrigin);
  }

  idleSeconds = Math.min(0, first) - 1;
  // One frame now: shaders, the texture and the code paths are warm before the first real one.
  scene.draw(idleSeconds, 0);
  running = true;
  scope.postMessage({
    type: 'ready',
    title: simfile.title,
    notes: loaded.notes.length,
    firstSeconds: first,
    lastSeconds: judge.lastJudgementSeconds,
    tracks: chart.tracks,
  });
  raf = scope.requestAnimationFrame(frame);
  if (messageMode) startClockSync();
}

function frame(ts: number): void {
  if (!running || !renderer || !judge || !scene || !inputSource || !clock || !settings) return;
  const t0 = performance.now();
  if (lastTs >= 0) intervals.push(ts - lastTs);
  lastTs = ts;
  callbackDelay.push(t0 - ts);
  const frameMain = ts + toMain;
  const nowMain = t0 + toMain;
  scene.setClock(frameMain);

  const playing = clock.read();
  let drawSeconds = idleSeconds;
  frameStampCount = 0;
  if (playing) {
    while (inputSource!.pop(rec)) {
      const stamp = rec[3]!;
      const seconds = clock.musicSecondsAt(stamp) + globalOffset;
      const track = rec[1]!;
      if (track < 0 || track >= judge.numTracks) continue;
      inputs++;
      if (seconds < judge.now) lateInputs++;
      if (rec[2] === 1) judge.press(track, seconds);
      else judge.release(track, seconds);
      if (frameStampCount < frameStamps.length) frameStamps[frameStampCount++] = stamp;
      if (inputLog && inputLogCount < LOG_INPUTS) {
        const o = inputLogCount++ * 4;
        inputLog[o] = stamp;
        inputLog[o + 1] = seconds;
        inputLog[o + 2] = track;
        inputLog[o + 3] = rec[2]!;
      }
    }
    drawSeconds = clock.musicSecondsAt(frameMain + settings.visualLeadMs) + globalOffset;
    // Autoplay steps when the arrow is drawn on the receptor. A player's inputs may still be
    // on their way: the clock-driven judging stays a little behind.
    judge.advance(settings.autoplay ? drawSeconds : clock.musicSecondsAt(nowMain) + globalOffset - settings.judgeLagMs / 1000);
    idleSeconds = drawSeconds;
  } else {
    while (inputSource!.pop(rec)) {} // not playing: inputs mean nothing
  }

  scene.draw(drawSeconds, frameMain);

  const t6 = performance.now();
  for (let i = 0; i < frameStampCount; i++) inputToFrame.push(t6 + toMain - frameStamps[i]!);
  frames++;
  cpu.push(t6 - t0);

  if (playing && !finishedSent && judge.finished && drawSeconds > judge.lastJudgementSeconds + END_SECONDS) {
    finishedSent = true;
    scope.postMessage({ type: 'finished', results: results() });
  }
  raf = scope.requestAnimationFrame(frame);
}

function results(): Results {
  const j = judge!;
  const k = j.keeper;
  return {
    w1: k.tapNoteScores[TNS.W1]!,
    w2: k.tapNoteScores[TNS.W2]!,
    w3: k.tapNoteScores[TNS.W3]!,
    w4: k.tapNoteScores[TNS.W4]!,
    w5: k.tapNoteScores[TNS.W5]!,
    miss: k.tapNoteScores[TNS.Miss]!,
    minesHit: k.tapNoteScores[TNS.HitMine]!,
    held: k.holdNoteScores[HNS.Held]!,
    letGo: k.holdNoteScores[HNS.LetGo]!,
    missedHolds: k.holdNoteScores[HNS.Missed]!,
    rows: k.totals.tapsAndHolds,
    holds: k.totals.holds,
    rolls: k.totals.rolls,
    actualDancePoints: k.actualDancePoints,
    possibleDancePoints: k.possibleDancePoints,
    percent: Math.round(k.percentDancePoints() * 10000) / 100,
    score: k.score,
    maxCombo: k.maxCombo,
    grade: GRADE_NAMES[k.grade()]!,
    failed: k.failed,
    life: j.life.life,
    autoplay: j.autoplay,
    complete: j.finished,
  };
}

function telemetry(): Telemetry {
  const iv = summarize(intervals.values());
  let late = 0;
  if (iv) {
    const limit = iv.p50 * 1.5;
    const v = intervals.values();
    for (let i = 0; i < v.length; i++) if (v[i]! > limit) late++;
  }
  const gl = renderer!.gl;
  const ext = gl.getExtension('WEBGL_debug_renderer_info');
  return {
    frames,
    canvas: { width: renderer!.canvas.width, height: renderer!.canvas.height },
    renderer: String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER)),
    refreshHz: iv && iv.p50 > 0 ? round(1000 / iv.p50, 2) : null,
    frameIntervalMs: roundSummary(iv),
    lateFrames: late,
    onTimePercent: iv ? round(100 * (1 - late / iv.n), 3) : null,
    rafCallbackDelayMs: roundSummary(summarize(callbackDelay.values())),
    frameCpuMs: roundSummary(summarize(cpu.values())),
    inputToFrameMs: roundSummary(summarize(inputToFrame.values())),
    inputs,
    lateInputs,
    ringDropped: inputSource!.dropped,
    quadsDropped: renderer!.dropped,
    clockOffsetErrorMs: clockOffsetError === null ? null : round(clockOffsetError, 4),
    clockOffsetSamples,
  };
}

function log(): ReportLog | null {
  if (!inputLog || !eventLog) return null;
  const out: ReportLog = { inputs: [], events: [] };
  for (let i = 0; i < inputLogCount; i++) out.inputs.push([...inputLog.subarray(i * 4, i * 4 + 4)]);
  for (let i = 0; i < eventLogCount; i++) out.events.push([...eventLog.subarray(i * 5, i * 5 + 5)]);
  return out;
}

scope.onmessage = (e: MessageEvent) => {
  const msg = e.data as ToWorker;
  try {
    if (msg.type === 'init') {
      init(msg);
    } else if (msg.type === 'input') {
      messageInput?.push(msg.record);
    } else if (msg.type === 'clock') {
      clock?.write(msg.fitPerf, msg.fitContext, msg.fitSlope, msg.musicOffsetSeconds);
    } else if (msg.type === 'clock-sync-reply') {
      const w2 = performance.now();
      const measured = ((msg.receivedPageNow - msg.workerNow) + (msg.pageNow - w2)) / 2;
      syncSum += measured;
      if (++syncCount >= SYNC_SAMPLES) {
        toMain = syncSum / SYNC_SAMPLES;
        clockOffsetError = toMain - initialToMain;
        clockOffsetSamples = syncCount;
      }
    } else if (msg.type === 'resize') {
      if (renderer && msg.width > 0 && msg.height > 0) {
        renderer.canvas.width = msg.width;
        renderer.canvas.height = msg.height;
      }
    } else if (msg.type === 'background') {
      renderer?.setBackground(msg.bitmap, msg.dim);
      msg.bitmap.close();
    } else if (msg.type === 'report') {
      if (judge && renderer) scope.postMessage({ type: 'report', results: results(), telemetry: telemetry(), log: log() });
    } else if (msg.type === 'stop') {
      running = false;
      scope.cancelAnimationFrame(raf);
      if (judge && renderer) scope.postMessage({ type: 'report', results: results(), telemetry: telemetry(), log: log() });
    }
  } catch (err) {
    scope.postMessage({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
