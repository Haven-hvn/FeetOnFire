// Render worker for the Latency Lab: WebGL2 on an OffscreenCanvas, driven by
// requestAnimationFrame inside the worker, the same arrangement the game will use.
//
// Measures frame pacing, how late the frame callback runs, CPU time per frame, and how
// old each input event is when the first frame that can react to it starts.

import { toMainTime } from '../shared/clock.ts';
import { EventRing } from '../shared/ring.ts';
import { Series, round, roundSummary, summarize } from '../shared/stats.ts';
import { EV_FIELDS, KIND_HID, KIND_KEY, KIND_PAD } from './hid-types.ts';

interface WorkerScope {
  onmessage: ((e: MessageEvent) => void) | null;
  postMessage(message: unknown): void;
  requestAnimationFrame(callback: (time: number) => void): number;
  cancelAnimationFrame(handle: number): void;
}

interface InitMessage {
  type: 'init';
  canvas: OffscreenCanvas;
  mainOrigin: number;
  rings: (SharedArrayBuffer | null)[];
  desync: boolean;
  probe: SharedArrayBuffer | null;
}

type Command =
  | InitMessage
  | { type: 'resize'; width: number; height: number }
  | { type: 'flashes'; times: number[] }
  | { type: 'report' }
  | { type: 'stop' };

const scope = globalThis as unknown as WorkerScope;

const FLASH_MS = 60;
const MAX_FLASHES = 256;

let gl: WebGL2RenderingContext | null = null;
let canvas: OffscreenCanvas | null = null;
let mainOrigin = performance.timeOrigin;
let rings: EventRing[] = [];
let raf = 0;
let running = false;
let desyncRequested = false;
let clock: Record<string, unknown> | string = 'unavailable (no SharedArrayBuffer)';

let frames = 0;
let lastTs = -1;
const intervals = new Series(4096);
const callbackDelay = new Series(4096);
const cpu = new Series(4096);
const inputAge = new Series(1024);
const flashDelay = new Series(256);
const kinds = { key: 0, hid: 0, pad: 0 };
const rec = new Float64Array(EV_FIELDS);

const flashTimes = new Float64Array(MAX_FLASHES);
let flashCount = 0;
let flashNext = 0;
let flashShown = -1;

const mainNow = (): number => toMainTime(performance.now(), performance.timeOrigin, mainOrigin);

/**
 * Compare this thread's clock with the main thread's. The main thread writes its
 * performance.now() into shared memory in a tight loop; each time the value changes,
 * (our converted time - written value) is the read delay plus any offset between the
 * two clocks. The minimum over many changes is the offset error.
 */
function clockCheck(probe: SharedArrayBuffer): Record<string, unknown> {
  const view = new Float64Array(probe);
  const diffs: number[] = [];
  let last = view[0];
  const start = performance.now();
  let lastChange = start;
  scope.postMessage({ type: 'clock-ready' });
  for (;;) {
    const v = view[0];
    const local = performance.now();
    if (v !== last) {
      last = v;
      lastChange = local;
      diffs.push(toMainTime(local, performance.timeOrigin, mainOrigin) - v);
    }
    if (local - start > 400) break;
    if (diffs.length > 0 && local - lastChange > 15) break;
  }
  const s = summarize(diffs);
  return s
    ? { samples: s.n, offsetErrorMs: round(s.min, 4), medianMs: round(s.p50, 4), timeOriginDeltaMs: round(performance.timeOrigin - mainOrigin, 3) }
    : { samples: 0, note: 'main thread did not answer in time' };
}

function init(msg: InitMessage): void {
  canvas = msg.canvas;
  mainOrigin = msg.mainOrigin;
  desyncRequested = msg.desync;
  rings = msg.rings.filter((b): b is SharedArrayBuffer => b !== null).map((b) => new EventRing(b, EV_FIELDS));
  gl = canvas.getContext('webgl2', {
    alpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    desynchronized: msg.desync,
    powerPreference: 'high-performance',
    preserveDrawingBuffer: false,
  });
  if (!gl) {
    scope.postMessage({ type: 'error', message: 'WebGL2 is not available on an OffscreenCanvas here' });
    return;
  }
  if (msg.probe) clock = clockCheck(msg.probe);
  scope.postMessage({ type: 'clock', clock });

  // Events that piled up before this worker existed say nothing about frame timing.
  for (const ring of rings) while (ring.pop(rec)) {}

  running = true;
  scope.postMessage({ type: 'started' });
  raf = scope.requestAnimationFrame(frame);
}

function frame(ts: number): void {
  if (!running || !gl || !canvas) return;
  const t0 = performance.now();
  const nowMain = toMainTime(t0, performance.timeOrigin, mainOrigin);
  if (lastTs >= 0) intervals.push(ts - lastTs);
  lastTs = ts;
  callbackDelay.push(t0 - ts);

  for (const ring of rings) {
    while (ring.pop(rec)) {
      if (rec[0] === KIND_KEY) kinds.key++;
      else if (rec[0] === KIND_HID) kinds.hid++;
      else if (rec[0] === KIND_PAD) kinds.pad++;
      if (rec[2] === 1) inputAge.push(nowMain - rec[3]);
    }
  }

  // Flash state.
  while (flashNext < flashCount && nowMain >= flashTimes[flashNext] + FLASH_MS) flashNext++;
  const flashing = flashNext < flashCount && nowMain >= flashTimes[flashNext];
  if (flashing && flashShown !== flashNext) {
    flashShown = flashNext;
    flashDelay.push(nowMain - flashTimes[flashNext]);
  }

  const w = canvas.width;
  const h = canvas.height;
  gl.viewport(0, 0, w, h);
  gl.disable(gl.SCISSOR_TEST);
  gl.clearColor(0.04, 0.05, 0.07, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.enable(gl.SCISSOR_TEST);

  // Bar moving at constant speed in time: uneven motion means uneven frame delivery.
  const barW = Math.max(4, Math.round(w / 80));
  const x = Math.floor(((nowMain * 0.5) % 1000) * 0.001 * (w + barW)) - barW;
  gl.scissor(Math.max(0, x), 0, barW, h);
  gl.clearColor(0.85, 0.87, 0.9, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);

  // Flash patch (top left): white while a flash is due. For the eye now, a light sensor later.
  const patch = Math.round(Math.min(w, h) * 0.3);
  gl.scissor(0, h - patch, patch, patch);
  if (flashing) gl.clearColor(1, 1, 1, 1);
  else gl.clearColor(0, 0, 0, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);

  // Frame parity patch (top right): alternates every frame, for counting frames on camera.
  const tick = Math.max(8, Math.round(patch / 4));
  gl.scissor(w - tick, h - tick, tick, tick);
  if (frames & 1) gl.clearColor(1, 1, 1, 1);
  else gl.clearColor(0, 0, 0, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);

  frames++;
  cpu.push(performance.now() - t0);
  raf = scope.requestAnimationFrame(frame);
}

function report(): Record<string, unknown> {
  const iv = summarize(intervals.values());
  let missed = 0;
  if (iv) {
    const limit = iv.p50 * 1.5;
    const v = intervals.values();
    for (let i = 0; i < v.length; i++) if (v[i] > limit) missed++;
  }
  const attrs = gl?.getContextAttributes();
  let renderer: unknown = null;
  if (gl) {
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    renderer = gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER);
  }
  return {
    frames,
    canvas: canvas ? { width: canvas.width, height: canvas.height } : null,
    renderer,
    desynchronized: { requested: desyncRequested, actual: attrs?.desynchronized ?? null },
    frameIntervalMs: roundSummary(iv),
    refreshHzEstimate: iv && iv.p50 > 0 ? round(1000 / iv.p50, 2) : null,
    // Intervals longer than 1.5x the median.
    missedFrames: missed,
    // Callback start minus the frame time the browser passed in.
    rafCallbackDelayMs: roundSummary(summarize(callbackDelay.values())),
    frameCpuMs: roundSummary(summarize(cpu.values())),
    // Frame start minus event timestamp, for "down" events. Uniform between 0 and one
    // frame interval is the best a frame-locked renderer can do.
    inputAgeAtFrameStartMs: roundSummary(summarize(inputAge.values())),
    inputEvents: { ...kinds },
    flashes: { scheduled: flashCount, shown: flashDelay.n, startDelayMs: roundSummary(summarize(flashDelay.values())) },
  };
}

scope.onmessage = (e: MessageEvent) => {
  const cmd = e.data as Command;
  if (cmd.type === 'init') {
    try {
      init(cmd);
    } catch (err) {
      scope.postMessage({ type: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  } else if (cmd.type === 'resize') {
    if (canvas && cmd.width > 0 && cmd.height > 0) {
      canvas.width = cmd.width;
      canvas.height = cmd.height;
    }
  } else if (cmd.type === 'flashes') {
    // Keep flashes that are still pending, then append (times arrive in ascending order).
    if (flashNext > 0) {
      flashTimes.copyWithin(0, flashNext, flashCount);
      flashCount -= flashNext;
      flashNext = 0;
      flashShown = -1;
    }
    for (const t of cmd.times) if (flashCount < MAX_FLASHES) flashTimes[flashCount++] = t;
  } else if (cmd.type === 'report') {
    scope.postMessage({ type: 'report', report: report() });
  } else if (cmd.type === 'stop') {
    running = false;
    scope.cancelAnimationFrame(raf);
    scope.postMessage({ type: 'report', report: report() });
  }
};
