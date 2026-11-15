// The gameplay test page (lab/play/): pick song files, choose a chart, play, see the result.
// Minimal on purpose: import, song list, settings and calibration are phase 6.

import { decodeAudioFile } from '../audio/decode.ts';
import { AudioEngine } from '../audio/engine.ts';
import type { DecodedAudio } from '../audio/pcm.ts';
import { loadChartNotes, parseSimfile, simfileFormatOf, type Simfile, type SimfileFormat } from '../chart/index.ts';
import { parseSpeed } from './field.ts';
import type { PlaySettings, Results } from './protocol.ts';
import { GameSession, type SessionReport } from './session.ts';

interface SongEntry {
  /** Folder of the simfile within what was picked, '' at the top. */
  dir: string;
  file: File;
  format: SimfileFormat;
  label: string;
}

interface Loaded {
  entry: SongEntry;
  bytes: Uint8Array;
  simfile: Simfile;
}

const AUDIO = /\.(ogg|oga|mp3|wav)$/i;

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const songSelect = $<HTMLSelectElement>('song');
const chartSelect = $<HTMLSelectElement>('chart');
const playButton = $<HTMLButtonElement>('play');
const stopButton = $<HTMLButtonElement>('stop');
const stage = $<HTMLDivElement>('stage');
const out = $<HTMLPreElement>('out');
const songOut = $<HTMLPreElement>('song-out');
const status = $<HTMLSpanElement>('status');

const files = new Map<string, File>();
let songs: SongEntry[] = [];
let loaded: Loaded | null = null;
let engine: AudioEngine | null = null;
let session: GameSession | null = null;
let lastReport: SessionReport | null = null;
let busy = false;

const pathOf = (file: File): string => file.webkitRelativePath || file.name;
const dirOf = (path: string): string => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');
const baseOf = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

function setFiles(list: FileList | File[]): void {
  files.clear();
  for (const file of list) files.set(pathOf(file), file);
  // One entry per folder: the .ssc when both it and a .sm are there, as StepMania chooses.
  const byDir = new Map<string, SongEntry>();
  for (const [path, file] of files) {
    const format = simfileFormatOf(path);
    if (!format) continue;
    const dir = dirOf(path);
    const have = byDir.get(dir);
    if (have && (have.format === 'ssc' || format === 'sm')) continue;
    byDir.set(dir, { dir, file, format, label: dir ? `${baseOf(dir)} (${baseOf(path)})` : baseOf(path) });
  }
  songs = [...byDir.values()].sort((a, b) => a.label.localeCompare(b.label));
  songSelect.replaceChildren(...songs.map((song, i) => new Option(song.label, String(i))));
  songSelect.disabled = songs.length === 0;
  songOut.textContent = songs.length === 0 ? 'No .ssc or .sm file among what was picked.' : '';
  void chooseSong();
}

async function chooseSong(): Promise<void> {
  loaded = null;
  chartSelect.replaceChildren();
  chartSelect.disabled = true;
  playButton.disabled = true;
  const entry = songs[Number(songSelect.value)];
  if (!entry) return;
  const bytes = new Uint8Array(await entry.file.arrayBuffer());
  const simfile = parseSimfile(bytes, entry.format, { path: pathOf(entry.file) });
  loaded = { entry, bytes, simfile };
  const options: HTMLOptionElement[] = [];
  for (const chart of simfile.charts) {
    const playable = chart.stepsType === 'dance-single';
    const option = new Option(`${chart.stepsType} ${chart.difficulty ?? ''} ${chart.meter}${playable ? '' : ' (not playable yet)'}`, String(chart.index));
    option.disabled = !playable;
    options.push(option);
  }
  chartSelect.replaceChildren(...options);
  const first = options.find((o) => !o.disabled);
  if (first) first.selected = true;
  chartSelect.disabled = !first;
  playButton.disabled = !first || busy;
  const music = findMusic(loaded, simfile.music);
  songOut.textContent = [
    `${simfile.title}${simfile.subtitle ? ` ${simfile.subtitle}` : ''} / ${simfile.artist}`,
    `Music: ${music ? baseOf(pathOf(music)) : 'none found: the chart will play in silence'}`,
    ...simfile.warnings.slice(0, 8).map((w) => `Note: ${w}`),
  ].join('\n');
}

/** The music file: the one the simfile names, else any audio file beside it (as StepMania). */
function findMusic(song: Loaded, name: string): File | null {
  const prefix = song.entry.dir ? `${song.entry.dir}/` : '';
  const wanted = (prefix + name).toLowerCase();
  let any: File | null = null;
  for (const [path, file] of files) {
    if (dirOf(path) !== song.entry.dir) continue;
    if (name && path.toLowerCase() === wanted) return file;
    if (!any && AUDIO.test(path)) any = file;
  }
  return any;
}

function settingsFromPage(): Partial<PlaySettings> {
  const speed = parseSpeed($<HTMLInputElement>('speed').value) ?? { mode: 'x' as const, value: 1 };
  const offset = Number($<HTMLInputElement>('offset').value);
  return {
    globalOffsetMs: Number.isFinite(offset) ? offset : 0,
    autoplay: $<HTMLInputElement>('autoplay').checked,
    failType: $<HTMLInputElement>('failoff').checked ? 'off' : 'immediate',
    scroll: { ...speed, reverse: $<HTMLInputElement>('reverse').checked },
  };
}

export interface PlayRequest {
  settings?: Partial<PlaySettings>;
  chartIndex?: number;
  minSecondsToStep?: number;
  minSecondsToMusic?: number;
}

/** Starts the chosen chart. Must be called from a click or key handler the first time (audio). */
async function play(request: PlayRequest = {}): Promise<void> {
  if (busy || session || !loaded) return;
  busy = true;
  playButton.disabled = true;
  try {
    const song = loaded;
    const chartIndex = request.chartIndex ?? Number(chartSelect.value);
    const chart = song.simfile.charts[chartIndex];
    if (!chart) throw new Error('No chart chosen');

    status.textContent = 'Starting audio…';
    engine ??= await AudioEngine.create();
    await engine.resume();

    status.textContent = 'Decoding music…';
    const musicFile = findMusic(song, chart.music || song.simfile.music);
    let audio: DecodedAudio;
    if (musicFile) {
      audio = await decodeAudioFile(new Uint8Array(await musicFile.arrayBuffer()), musicFile.name);
    } else {
      // No music: a moment of silence, and music time simply runs on.
      audio = { sampleRate: engine.sampleRate, channels: [new Float32Array(1)], frames: 1, format: 'wav', decoder: 'wav', notes: ['no music file'] };
    }
    await engine.loadMusic(audio);

    status.textContent = 'Loading chart…';
    session = await GameSession.start(stage, engine, {
      simfile: song.bytes,
      format: song.entry.format,
      path: pathOf(song.entry.file),
      chartIndex,
      settings: { ...settingsFromPage(), ...request.settings },
      ...(request.minSecondsToStep !== undefined ? { minSecondsToStep: request.minSecondsToStep } : {}),
      ...(request.minSecondsToMusic !== undefined ? { minSecondsToMusic: request.minSecondsToMusic } : {}),
    });
    session.onFinished = () => void stop();
    session.onError = (message) => {
      status.textContent = `Error: ${message}`;
      void stop();
    };
    const { notes } = loadChartNotes(chart);
    status.textContent = `Playing: ${song.simfile.title}, ${chart.difficulty ?? ''} ${chart.meter}, ${notes.length} notes`;
    stopButton.disabled = false;
    out.textContent = 'Playing…';
  } catch (error) {
    status.textContent = `Error: ${error instanceof Error ? error.message : String(error)}`;
    session = null;
    playButton.disabled = !loaded;
  } finally {
    busy = false;
  }
}

async function stop(): Promise<SessionReport | null> {
  const current = session;
  if (!current) return lastReport;
  session = null;
  stopButton.disabled = true;
  if (document.fullscreenElement) void document.exitFullscreen();
  const report = await current.stop();
  if (report) {
    lastReport = report;
    out.textContent = describe(report, engine);
  }
  if (!status.textContent?.startsWith('Error')) status.textContent = 'Stopped.';
  playButton.disabled = !loaded;
  return report;
}

function line(label: string, value: string | number): string {
  return `${label.padEnd(22)}${value}`;
}

function describe(report: SessionReport, audio: AudioEngine | null): string {
  const r: Results = report.results;
  const t = report.telemetry;
  const clock = audio?.clockReport();
  return [
    r.autoplay ? 'AUTOPLAY' : r.complete ? 'Song complete' : 'Stopped before the end',
    line('Grade', r.failed ? 'Failed' : r.complete ? r.grade : `${r.grade} (so far)`),
    line('Percent', `${r.percent.toFixed(2)} %  (${r.actualDancePoints} of ${r.possibleDancePoints} dance points)`),
    line('Score', r.score.toLocaleString('en-US')),
    line('Max combo', r.maxCombo),
    '',
    line('Flawless', r.w1),
    line('Perfect', r.w2),
    line('Great', r.w3),
    line('Good', r.w4),
    line('Boo', r.w5),
    line('Miss', r.miss),
    line('Holds and rolls', `${r.held} OK, ${r.letGo} NG, ${r.missedHolds} missed, of ${r.holds + r.rolls}`),
    line('Mines hit', r.minesHit),
    '',
    'Timing of this run (docs/LATENCY.md section 4)',
    line('Frames', `${t.frames} at ${t.refreshHz ?? '?'} Hz, ${t.onTimePercent ?? '?'} % on time (${t.lateFrames} late)`),
    line('Frame CPU ms', JSON.stringify(t.frameCpuMs)),
    line('Input to frame ms', JSON.stringify(t.inputToFrameMs)),
    line('Inputs', `${t.inputs} (${t.lateInputs} after judging had passed them, ${t.ringDropped} dropped)`),
    line('Worker clock', `${t.clockOffsetErrorMs ?? '?'} ms off through timeOrigin, corrected (${t.clockOffsetSamples} samples)`),
    line('Audio clock', clock ? `${clock.predictionRmsMs ?? '?'} ms RMS, worst ${clock.predictionMaxMs ?? '?'} ms, ${clock.steps} steps, ${clock.resets} resets` : '?'),
    line('Output latency', audio ? `${((audio.context.baseLatency + audio.context.outputLatency) * 1000).toFixed(1)} ms reported` : '?'),
    line('Renderer', t.renderer),
  ].join('\n');
}

$<HTMLInputElement>('folder').addEventListener('change', (e) => setFiles((e.target as HTMLInputElement).files ?? []));
$<HTMLInputElement>('files').addEventListener('change', (e) => setFiles((e.target as HTMLInputElement).files ?? []));
songSelect.addEventListener('change', () => void chooseSong());
playButton.addEventListener('click', () => void play());
stopButton.addEventListener('click', () => void stop());
$<HTMLButtonElement>('fullscreen').addEventListener('click', () => void stage.requestFullscreen());
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && session) void stop();
});
if (!globalThis.crossOriginIsolated) $<HTMLParagraphElement>('warning').hidden = false;

// For the end-to-end test and for poking at from the console.
const hooks = {
  setFiles,
  play,
  stop,
  get session(): GameSession | null {
    return session;
  },
  get engine(): AudioEngine | null {
    return engine;
  },
  get lastReport(): SessionReport | null {
    return lastReport;
  },
  get songs(): string[] {
    return songs.map((s) => s.label);
  },
  get ready(): boolean {
    return loaded !== null && !busy;
  },
};
(window as unknown as { __play: typeof hooks }).__play = hooks;
