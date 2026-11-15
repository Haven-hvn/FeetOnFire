// Latency Lab page: wires the controls to the input, audio, video and acoustic tests and
// assembles the downloadable report. See docs/LATENCY.md for what each number means.

import { measureRoundTrip, tapTest } from './acoustic.ts';
import { AudioLab } from './audio.ts';
import { InputLab, type HidMode } from './input.ts';
import { VideoLab } from './video.ts';
import { round } from '../shared/stats.ts';

const input = new InputLab();
const audio = new AudioLab();
const video = new VideoLab();
const acoustic: { roundTrip: Record<string, unknown> | null; tapTest: Record<string, unknown> | null } = { roundTrip: null, tapTest: null };
let roundTripFrames: number | null = null;

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing element #${id}`);
  return node as T;
}

function show(id: string, value: unknown): void {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  const node = el<HTMLElement>(id);
  if (node.textContent !== text) node.textContent = text;
}

/** Run a click handler; put any failure where the user is looking. */
function guarded(outId: string, fn: () => Promise<void> | void): () => void {
  return () => {
    Promise.resolve()
      .then(fn)
      .catch((err: unknown) => show(outId, `Error: ${err instanceof Error ? err.message : String(err)}`));
  };
}

// ------------------------------------------------------------- environment

function timerResolutionMs(): number {
  let smallest = Infinity;
  let last = performance.now();
  const end = last + 20;
  while (last < end) {
    const t = performance.now();
    if (t > last) {
      if (t - last < smallest) smallest = t - last;
      last = t;
    }
  }
  return smallest;
}

function environment(): Record<string, unknown> {
  const nav = navigator as Navigator & { userAgentData?: { brands?: { brand: string; version: string }[]; platform?: string } };
  return {
    userAgent: nav.userAgent,
    brands: nav.userAgentData?.brands?.map((b) => `${b.brand} ${b.version}`) ?? null,
    platform: nav.userAgentData?.platform ?? null,
    hardwareConcurrency: nav.hardwareConcurrency,
    secureContext: window.isSecureContext,
    crossOriginIsolated: window.crossOriginIsolated,
    sharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined',
    timerResolutionMs: round(timerResolutionMs(), 4),
    devicePixelRatio: window.devicePixelRatio,
    screen: { width: screen.width, height: screen.height },
    features: {
      webHid: 'hid' in navigator,
      gamepad: 'getGamepads' in navigator,
      audioWorklet: 'AudioWorkletNode' in window,
      offscreenCanvas: 'OffscreenCanvas' in window && 'transferControlToOffscreen' in HTMLCanvasElement.prototype,
      webCodecsAudioDecoder: 'AudioDecoder' in window,
      originPrivateFileSystem: typeof navigator.storage?.getDirectory === 'function',
      decompressionStream: 'DecompressionStream' in window,
    },
  };
}

const env = environment();

// ------------------------------------------------------------------ report

async function buildReport(withTrace = false): Promise<Record<string, unknown>> {
  return {
    schema: 1,
    createdAt: new Date().toISOString(),
    env,
    clock: video.clock,
    input: await input.report(),
    audio: audio.report(),
    video: await video.report(),
    acoustic,
    // Raw clock pairs: large, so only in the downloaded file.
    ...(withTrace ? { audioTrace: audio.trace() } : {}),
  };
}

let refreshing = false;
async function refresh(): Promise<void> {
  if (refreshing) return;
  refreshing = true;
  try {
    show('input-out', await input.report());
    if (audio.running) show('audio-out', audio.report());
    if (video.running) show('video-out', { clock: video.clock, ...(await video.report()) });
  } finally {
    refreshing = false;
  }
}

// ------------------------------------------------------------------- wiring

function toggleLabel(button: HTMLButtonElement, on: boolean, name: string): void {
  button.textContent = `${on ? 'Stop' : 'Start'} ${name}`;
  button.classList.toggle('on', on);
}

function wire(): void {
  show('env', env);
  if (!window.crossOriginIsolated) {
    el('warning').hidden = false;
  }

  // Input
  const kbd = el<HTMLButtonElement>('kbd-toggle');
  kbd.onclick = guarded('input-out', () => {
    if (input.keyboardActive) input.stopKeyboard();
    else input.startKeyboard();
    kbd.blur();
    toggleLabel(kbd, input.keyboardActive, 'keyboard test');
  });

  const pad = el<HTMLButtonElement>('pad-toggle');
  pad.onclick = guarded('input-out', () => {
    if (input.gamepadActive) input.stopGamepad();
    else input.startGamepad();
    toggleLabel(pad, input.gamepadActive, 'Gamepad API test');
  });

  const busy = el<HTMLInputElement>('busy-toggle');
  busy.onchange = () => input.setBusy(busy.checked);

  const hidDevices = el('hid-devices');
  const listDevices = (names: string[]): void => {
    hidDevices.textContent = names.length ? names.join(', ') : 'none';
  };
  el<HTMLButtonElement>('hid-connect').onclick = guarded('input-out', async () => {
    listDevices(await input.connectHid());
  });
  const hid = el<HTMLButtonElement>('hid-toggle');
  hid.onclick = guarded('input-out', async () => {
    try {
      if (input.hidActive) await input.stopHid();
      else await input.startHid(el<HTMLSelectElement>('hid-mode').value as HidMode);
    } finally {
      toggleLabel(hid, input.hidActive, 'WebHID test');
    }
  });
  if (input.hidAvailable) {
    input.knownHidDevices().then(listDevices, () => undefined);
  } else {
    hidDevices.textContent = 'WebHID is not available in this browser';
    el<HTMLButtonElement>('hid-connect').disabled = true;
    hid.disabled = true;
  }

  // Audio
  const audioToggle = el<HTMLButtonElement>('audio-toggle');
  audioToggle.onclick = guarded('audio-out', async () => {
    try {
      if (audio.running) {
        show('audio-out', audio.report());
        await audio.stop();
      } else {
        const hint = el<HTMLSelectElement>('audio-hint').value;
        const seconds = Number(hint);
        await audio.start(Number.isFinite(seconds) ? seconds : (hint as AudioContextLatencyCategory), el<HTMLInputElement>('audio-awake').checked);
      }
    } finally {
      toggleLabel(audioToggle, audio.running, 'audio test');
    }
  });
  el<HTMLButtonElement>('audio-clicks').onclick = guarded('audio-out', () => {
    const frames = audio.scheduleClicks(8, 500);
    video.flashAt(frames.map((f) => audio.heardPerfTime(f)));
  });

  // Video
  const videoToggle = el<HTMLButtonElement>('video-toggle');
  videoToggle.onclick = guarded('video-out', async () => {
    try {
      if (video.running) {
        await video.stop();
        show('video-out', { clock: video.clock, ...video.lastReport });
      } else {
        await video.start(el('video-host'), el<HTMLInputElement>('video-desync').checked, input.sharedRings());
      }
    } finally {
      toggleLabel(videoToggle, video.running, 'video test');
    }
  });
  el<HTMLButtonElement>('video-fullscreen').onclick = guarded('video-out', async () => {
    await el('video-host').requestFullscreen();
  });

  // Acoustic
  const acousticStatus = (text: string): void => show('acoustic-status', text);
  el<HTMLButtonElement>('mic-attach').onclick = guarded('acoustic-out', async () => {
    await audio.attachMic();
    acousticStatus('Microphone attached.');
  });
  el<HTMLButtonElement>('rt-run').onclick = guarded('acoustic-out', async () => {
    if (!audio.hasMic) throw new Error('Start the audio test and attach the microphone first');
    acousticStatus('Playing 12 clicks…');
    const result = await measureRoundTrip(audio);
    roundTripFrames = result.roundTripFrames;
    acoustic.roundTrip = result.report;
    acousticStatus(
      roundTripFrames === null
        ? 'Clicks not reliably detected. Turn the speakers up, move the microphone closer, or quieten the room.'
        : `Round trip measured (${result.detected}/${result.clicks} clicks).`,
    );
    show('acoustic-out', acoustic);
  });
  el<HTMLButtonElement>('tap-run').onclick = guarded('acoustic-out', async () => {
    if (!audio.hasMic) throw new Error('Start the audio test and attach the microphone first');
    if (roundTripFrames === null) throw new Error('Run the round-trip test first');
    const seconds = 15;
    const startedAt = performance.now();
    const timer = window.setInterval(() => {
      const left = Math.max(0, seconds - (performance.now() - startedAt) / 1000);
      acousticStatus(`Recording: tap the pad or a key about once a second (${left.toFixed(0)} s left)…`);
    }, 250);
    try {
      const result = await tapTest(audio, () => input.taps, seconds, roundTripFrames);
      acoustic.tapTest = result.report;
      acousticStatus(result.report.accepted ? 'Tap test done.' : 'Tap test done, but too few taps could be told from other sounds: tap harder or closer to the microphone.');
    } finally {
      window.clearInterval(timer);
    }
    show('acoustic-out', acoustic);
  });

  // Report
  el<HTMLButtonElement>('report-refresh').onclick = guarded('report-out', async () => {
    show('report-out', await buildReport());
  });
  el<HTMLButtonElement>('report-download').onclick = guarded('report-out', async () => {
    const report = await buildReport(true);
    show('report-out', { ...report, audioTrace: report.audioTrace ? 'in the downloaded file' : null });
    const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'latency-report.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });

  window.setInterval(() => void refresh(), 500);
}

wire();

// For automated tests and for poking around in the console.
(window as unknown as { __lab: unknown }).__lab = { input, audio, video, buildReport };
