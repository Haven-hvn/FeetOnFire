// What the game keeps in the browser: imported songs (their files in the origin-private file
// system, their descriptions in IndexedDB), scores (IndexedDB) and settings (localStorage).
// Nothing leaves the machine.

import { DEFAULT_BINDINGS, cleanBindings, type Bindings } from '../game/bindings.ts';
import { baseOf, describeSong, planImport, type SongPlan, type SongRecord } from './library.ts';
import { readZip } from './zip.ts';

// ---------------------------------------------------------------- settings

export interface Settings {
  /** "2x", "C450", "M450". */
  speed: string;
  reverse: boolean;
  failOff: boolean;
  autoplay: boolean;
  /** StepMania's sense: negative makes the notes come later. */
  globalOffsetMs: number;
  visualLeadMs: number;
  /** Brightness of the song's picture behind the field, 0..1. */
  backgroundDim: number;
  bindings: Bindings;
}

export const DEFAULT_SETTINGS: Settings = {
  speed: '2x',
  reverse: false,
  failOff: false,
  autoplay: false,
  globalOffsetMs: 0,
  visualLeadMs: 0,
  backgroundDim: 0.3,
  bindings: { ...DEFAULT_BINDINGS },
};

const SETTINGS_KEY = 'dance.settings.v1';

export function loadSettings(): Settings {
  const out: Settings = { ...DEFAULT_SETTINGS, bindings: { ...DEFAULT_BINDINGS } };
  try {
    const raw = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? 'null') as Partial<Record<keyof Settings, unknown>> | null;
    if (!raw || typeof raw !== 'object') return out;
    if (typeof raw.speed === 'string' && raw.speed.length < 16) out.speed = raw.speed;
    for (const key of ['reverse', 'failOff', 'autoplay'] as const) if (typeof raw[key] === 'boolean') out[key] = raw[key];
    const number = (value: unknown, lo: number, hi: number, fallback: number): number =>
      typeof value === 'number' && Number.isFinite(value) ? Math.min(hi, Math.max(lo, value)) : fallback;
    out.globalOffsetMs = number(raw.globalOffsetMs, -1000, 1000, 0);
    out.visualLeadMs = number(raw.visualLeadMs, -500, 500, 0);
    out.backgroundDim = number(raw.backgroundDim, 0, 1, DEFAULT_SETTINGS.backgroundDim);
    if (raw.bindings !== undefined) out.bindings = cleanBindings(raw.bindings);
  } catch {
    // Unreadable: the defaults.
  }
  return out;
}

export function saveSettings(settings: Settings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Storage full or blocked: the settings last for this visit.
  }
}

// --------------------------------------------------------------- IndexedDB

export interface ScoreRecord {
  songId: string;
  chartKey: string;
  percent: number;
  grade: string;
  score: number;
  maxCombo: number;
  failed: boolean;
  date: number;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function db(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const open = indexedDB.open('dance', 1);
    open.onupgradeneeded = () => {
      open.result.createObjectStore('songs', { keyPath: 'id' });
      const scores = open.result.createObjectStore('scores', { autoIncrement: true });
      scores.createIndex('song', 'songId');
    };
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error ?? new Error('The song database could not be opened'));
  });
  return dbPromise;
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('Database request failed'));
  });
}

async function store(name: 'songs' | 'scores', mode: IDBTransactionMode): Promise<IDBObjectStore> {
  return (await db()).transaction(name, mode).objectStore(name);
}

export async function listSongs(): Promise<SongRecord[]> {
  const songs = (await request((await store('songs', 'readonly')).getAll())) as SongRecord[];
  return songs.sort((a, b) => a.pack.localeCompare(b.pack) || a.title.localeCompare(b.title));
}

export async function addScore(score: ScoreRecord): Promise<void> {
  await request((await store('scores', 'readwrite')).add(score));
}

/** The best (highest percent, not failed first) score of each chart of a song, by chart key. */
export async function bestScores(songId: string): Promise<Map<string, ScoreRecord>> {
  const all = (await request((await store('scores', 'readonly')).index('song').getAll(songId))) as ScoreRecord[];
  const best = new Map<string, ScoreRecord>();
  for (const score of all) {
    const have = best.get(score.chartKey);
    if (!have || (have.failed && !score.failed) || (have.failed === score.failed && score.percent > have.percent)) best.set(score.chartKey, score);
  }
  return best;
}

// -------------------------------------------------------------------- files

async function songsDir(): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle('songs', { create: true });
}

/** A stored file of a song, or null. */
export async function songFile(song: SongRecord, name: string): Promise<File | null> {
  if (!name) return null;
  try {
    const dir = await (await songsDir()).getDirectoryHandle(song.id);
    return await (await dir.getFileHandle(name)).getFile();
  } catch {
    return null;
  }
}

export async function deleteSong(song: SongRecord): Promise<void> {
  await request((await store('songs', 'readwrite')).delete(song.id));
  try {
    await (await songsDir()).removeEntry(song.id, { recursive: true });
  } catch {
    // Already gone.
  }
}

/** Asks the browser not to clear this site's storage when the disk fills. */
export async function storageState(): Promise<{ usedBytes: number; quotaBytes: number; persistent: boolean }> {
  const estimate = await navigator.storage.estimate();
  return { usedBytes: estimate.usage ?? 0, quotaBytes: estimate.quota ?? 0, persistent: await navigator.storage.persisted() };
}

export function requestPersistence(): Promise<boolean> {
  return navigator.storage.persist();
}

// ------------------------------------------------------------------- import

/** A file on its way in: its path within what was picked, and how to get its content. */
export interface Incoming {
  path: string;
  size: number;
  blob(): Promise<Blob>;
}

export interface ImportResult {
  added: SongRecord[];
  /** Songs already in the library (same pack, title and artist): replaced. */
  replaced: number;
  problems: string[];
}

/** Picked files, with zip files opened up into what they hold. */
export async function expand(files: readonly { path: string; file: Blob }[], problems: string[]): Promise<Incoming[]> {
  const out: Incoming[] = [];
  for (const { path, file } of files) {
    if (/\.(zip|smzip)$/i.test(path)) {
      try {
        const inside = path.replace(/\.(zip|smzip)$/i, '');
        for (const entry of await readZip(file)) {
          if (entry.problem) {
            if (/\.(sm|ssc|ogg|oga|mp3|wav)$/i.test(entry.path)) problems.push(`${baseOf(path)}: ${entry.path} skipped (${entry.problem})`);
            continue;
          }
          // A zip of one song folder, or of a pack, or of loose files: the zip's name stands above them.
          out.push({ path: `${baseOf(inside)}/${entry.path}`, size: entry.size, blob: () => entry.blob() });
        }
      } catch (error) {
        problems.push(`${baseOf(path)}: ${error instanceof Error ? error.message : String(error)}`);
      }
    } else {
      out.push({ path, size: file.size, blob: () => Promise.resolve(file) });
    }
  }
  return out;
}

function newId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Characters a stored file name may not carry are replaced; the simfile's references still match by base name. */
function safeName(name: string): string {
  return name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 200) || '_';
}

async function storeSong(plan: SongPlan, incoming: Map<string, Incoming>, existing: SongRecord[]): Promise<{ record: SongRecord; replaced: boolean }> {
  const id = newId();
  const dir = await (await songsDir()).getDirectoryHandle(id, { create: true });
  try {
    let total = 0;
    let simfileBytes: Uint8Array | null = null;
    const names: string[] = [];
    for (const path of plan.files) {
      const blob = await incoming.get(path)!.blob();
      const name = safeName(baseOf(path));
      if (names.includes(name)) continue;
      const writable = await (await dir.getFileHandle(name, { create: true })).createWritable();
      await writable.write(blob);
      await writable.close();
      names.push(name);
      total += blob.size;
      if (path === plan.simfile) simfileBytes = new Uint8Array(await blob.arrayBuffer());
    }
    if (!simfileBytes) throw new Error('the simfile could not be read');
    const { record } = describeSong(simfileBytes, { ...plan, simfile: safeName(baseOf(plan.simfile)) }, names, id, Date.now(), total);
    if (record.charts.length === 0) throw new Error('no charts in the file');
    // The same song imported again takes the place of the old copy; its scores stay with the old id's key.
    const old = existing.find((s) => s.pack === record.pack && s.title === record.title && s.artist === record.artist);
    if (old) {
      record.id = id;
      await moveScores(old.id, id);
      await deleteSong(old);
    }
    await request((await store('songs', 'readwrite')).put(record));
    return { record, replaced: old !== undefined };
  } catch (error) {
    await (await songsDir()).removeEntry(id, { recursive: true }).catch(() => undefined);
    throw error;
  }
}

async function moveScores(fromId: string, toId: string): Promise<void> {
  const scores = await store('scores', 'readwrite');
  await new Promise<void>((resolve, reject) => {
    const cursor = scores.index('song').openCursor(fromId);
    cursor.onsuccess = () => {
      const c = cursor.result;
      if (!c) return resolve();
      c.update({ ...(c.value as ScoreRecord), songId: toId });
      c.continue();
    };
    cursor.onerror = () => reject(cursor.error ?? new Error('Database request failed'));
  });
}

/** Copies the songs among `files` into the library. `progress` is called before each song. */
export async function importFiles(files: readonly { path: string; file: Blob }[], progress?: (done: number, total: number, name: string) => void): Promise<ImportResult> {
  const result: ImportResult = { added: [], replaced: 0, problems: [] };
  const incoming = new Map<string, Incoming>();
  for (const item of await expand(files, result.problems)) incoming.set(item.path, item);
  const plans = planImport([...incoming.keys()]);
  const existing = await listSongs();
  let done = 0;
  for (const plan of plans) {
    progress?.(done++, plans.length, baseOf(plan.dir) || baseOf(plan.simfile));
    try {
      const { record, replaced } = await storeSong(plan, incoming, existing);
      result.added.push(record);
      existing.push(record);
      if (replaced) result.replaced++;
    } catch (error) {
      result.problems.push(`${plan.dir || plan.simfile}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (plans.length === 0 && result.problems.length === 0) result.problems.push('No .ssc or .sm file was found in what you picked.');
  return result;
}
