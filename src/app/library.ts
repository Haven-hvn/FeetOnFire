// What a set of picked files holds, as songs. Pure: no browser dependencies.

import { parseSimfile, simfileFormatOf, type Simfile, type SimfileFormat } from '../chart/index.ts';

const AUDIO = /\.(ogg|oga|mp3|wav)$/i;
const IMAGE = /\.(png|jpe?g|gif|bmp|webp)$/i;

export const dirOf = (path: string): string => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');
export const baseOf = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

export interface SongPlan {
  /** Folder of the song within what was picked; '' at the top. */
  dir: string;
  /** The folder above it: the pack; '' when there is none. */
  pack: string;
  /** Path of the simfile to read: the .ssc when both it and a .sm are there, as StepMania chooses. */
  simfile: string;
  format: SimfileFormat;
  /** Paths of the files worth keeping: the simfile, audio and pictures of the folder itself. */
  files: string[];
}

/** Groups paths ('Pack/Song/file.ext') into songs: one per folder that holds a simfile. */
export function planImport(paths: readonly string[]): SongPlan[] {
  const byDir = new Map<string, SongPlan>();
  for (const path of paths) {
    const format = simfileFormatOf(path);
    if (!format || baseOf(path).startsWith('.')) continue;
    const dir = dirOf(path);
    const have = byDir.get(dir);
    if (have && (have.format === 'ssc' || format === 'sm')) continue;
    byDir.set(dir, { dir, pack: baseOf(dirOf(dir)), simfile: path, format, files: [] });
  }
  for (const path of paths) {
    const plan = byDir.get(dirOf(path));
    if (!plan || baseOf(path).startsWith('.')) continue;
    if (path === plan.simfile || AUDIO.test(path) || IMAGE.test(path)) plan.files.push(path);
  }
  return [...byDir.values()].sort((a, b) => a.dir.localeCompare(b.dir));
}

export interface ChartRecord {
  index: number;
  stepsType: string;
  difficulty: string;
  meter: number;
  description: string;
  /** Identifies the chart across re-imports of the same song. */
  key: string;
  playable: boolean;
}

export interface SongRecord {
  id: string;
  title: string;
  subtitle: string;
  artist: string;
  pack: string;
  /** File names within the song's stored folder; '' when there is none. */
  simfile: string;
  format: SimfileFormat;
  music: string;
  background: string;
  banner: string;
  charts: ChartRecord[];
  bpmMin: number;
  bpmMax: number;
  /** The part to play in the song list: start and length in seconds (0: not given). */
  sampleStart?: number;
  sampleLength?: number;
  addedAt: number;
  bytes: number;
  warnings: string[];
}

/** The file among `names` that `wanted` means: exact, else whatever case, else ''. */
function findName(names: readonly string[], wanted: string): string {
  if (!wanted) return '';
  const base = baseOf(wanted.replace(/\\/g, '/'));
  return names.find((n) => n === base) ?? names.find((n) => n.toLowerCase() === base.toLowerCase()) ?? '';
}

/** Reads a simfile and describes the song. `names` are the file names stored beside it. */
export function describeSong(bytes: Uint8Array, plan: SongPlan, names: readonly string[], id: string, addedAt: number, totalBytes: number): { record: SongRecord; simfile: Simfile } {
  const simfile = parseSimfile(bytes, plan.format, { path: baseOf(plan.simfile) });
  const audio = names.filter((n) => AUDIO.test(n));
  const images = names.filter((n) => IMAGE.test(n));
  // As StepMania's Song::TidyUpData: the named file, else a likely one in the folder.
  const music = findName(names, simfile.music) || audio[0] || '';
  const background = findName(names, simfile.background) || images.find((n) => /bg|background/i.test(n)) || '';
  const banner = findName(names, simfile.banner) || images.find((n) => /bn|banner/i.test(n)) || '';
  let bpmMin = Infinity;
  let bpmMax = 0;
  for (const segment of simfile.timing.bpms) {
    const bpm = segment.bps * 60;
    if (bpm < bpmMin) bpmMin = bpm;
    if (bpm > bpmMax) bpmMax = bpm;
  }
  const record: SongRecord = {
    id,
    title: simfile.title || baseOf(plan.dir) || baseOf(plan.simfile),
    subtitle: simfile.subtitle,
    artist: simfile.artist,
    pack: plan.pack,
    simfile: baseOf(plan.simfile),
    format: plan.format,
    music,
    background,
    banner,
    charts: simfile.charts.map((chart) => ({
      index: chart.index,
      stepsType: chart.stepsType,
      difficulty: chart.difficulty ?? 'Edit',
      meter: chart.meter,
      description: chart.description,
      key: `${chart.stepsType}/${chart.difficulty ?? 'Edit'}/${chart.description}`,
      playable: chart.stepsType === 'dance-single',
    })),
    bpmMin: Number.isFinite(bpmMin) ? Math.round(bpmMin) : 0,
    bpmMax: Math.round(bpmMax),
    sampleStart: Number.isFinite(simfile.sampleStartSeconds) ? simfile.sampleStartSeconds : 0,
    sampleLength: Number.isFinite(simfile.sampleLengthSeconds) ? simfile.sampleLengthSeconds : 0,
    addedAt,
    bytes: totalBytes,
    warnings: simfile.warnings.slice(0, 20),
  };
  return { record, simfile };
}

/** True when every word of `query` is in the song's title, artist or pack. */
export function matches(song: SongRecord, query: string): boolean {
  const hay = `${song.title} ${song.subtitle} ${song.artist} ${song.pack}`.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .every((word) => hay.includes(word));
}

export const DIFFICULTY_ORDER = ['Beginner', 'Easy', 'Medium', 'Hard', 'Challenge', 'Edit'];
