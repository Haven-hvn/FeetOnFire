// The game's page: the song list, importing, and moving between screens.

import { decodeAudioFile } from '../audio/decode.ts';
import { AudioEngine } from '../audio/engine.ts';
import type { DecodedAudio } from '../audio/pcm.ts';
import { InputRouter } from '../game/input.ts';
import type { App } from './context.ts';
import { DIFFICULTY_ORDER, matches, type ChartRecord, type SongRecord } from './library.ts';
import { playScreen } from './play.ts';
import { settingsScreen } from './settings-screen.ts';
import { socialScreen } from './social-screen.ts';
import { menuSounds, mineSound, SFX } from './sounds.ts';
import { bestScores, deleteSong, importFiles, listSongs, loadSettings, saveSettings, songFile, type ScoreRecord } from './store.ts';
import { droppedFiles, h, megabytes, pickedFiles, type Screen } from './ui.ts';

const host = document.getElementById('app')!;
let current: Screen | null = null;
let engine: AudioEngine | null = null;
let enginePromise: Promise<AudioEngine> | null = null;

// What the song list remembers between visits to it.
let songs: SongRecord[] = [];
let selectedId: string | null = null;
let selectedChartKey: string | null = null;
let query = '';
let notice = '';

let musicQueue: Promise<unknown> = Promise.resolve();
/** The music last decoded for a preview: going back and forth between two songs is common. */
let previewCache: { id: string; audio: DecodedAudio } | null = null;

const settings = loadSettings();
const app: App = {
  settings,
  input: new InputRouter(settings.bindings),
  get engine() {
    return engine;
  },
  get audioAsked() {
    return enginePromise !== null;
  },
  audio() {
    enginePromise ??= AudioEngine.create().then(async (created) => {
      await created.loadSound(SFX.mine, mineSound(created.sampleRate));
      for (const [id, sound] of menuSounds(created.sampleRate)) await created.loadSound(id, sound);
      return (engine = created);
    });
    return enginePromise.then(async (e) => {
      await e.resume();
      return e;
    });
  },
  exclusive(task) {
    const run = musicQueue.then(task, task);
    musicQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  },
  sfx(name) {
    engine?.playSound(SFX[name]);
  },
  show(screen) {
    current?.close?.();
    current = screen;
    host.replaceChildren(screen.root);
  },
  home() {
    app.show(libraryScreen());
  },
  saveSettings() {
    saveSettings(app.settings);
  },
};

function hint(key: string, what: string): HTMLElement {
  return h('span', {}, h('kbd', {}, key), what);
}

/** The first screen: a key or click here is also what lets the browser start audio. */
function titleScreen(): Screen {
  const go = (): void => {
    void app.audio().then(() => app.sfx('confirm'));
    app.home();
  };
  const root = h('div', { class: 'screen title', onclick: go }, h('div', { class: 'logo' }, 'FeetOnFire'), h('p', { class: 'tagline' }, 'Plays StepMania songs in your browser'), h('p', { class: 'press' }, 'Press Enter'));
  return {
    root,
    onKey(e) {
      if (e.key !== 'Enter' && e.key !== ' ') return false;
      go();
      return true;
    },
  };
}

function playable(song: SongRecord): ChartRecord[] {
  return song.charts.filter((c) => c.playable).sort((a, b) => DIFFICULTY_ORDER.indexOf(a.difficulty) - DIFFICULTY_ORDER.indexOf(b.difficulty) || a.meter - b.meter);
}

function libraryScreen(): Screen {
  const list = h('div', { class: 'song-list', role: 'listbox', tabindex: 0, 'aria-label': 'Songs' });
  const detail = h('div', { class: 'detail' });
  const status = h('p', { class: 'notice', role: 'status', hidden: !notice }, notice);
  const search = h('input', { type: 'search', placeholder: 'Search songs', value: query, 'aria-label': 'Search songs' });
  const folderInput = h('input', { type: 'file', hidden: true });
  folderInput.setAttribute('webkitdirectory', '');
  const filesInput = h('input', { type: 'file', hidden: true, multiple: true, accept: '.zip,.smzip,.sm,.ssc,.ogg,.oga,.mp3,.wav,.png,.jpg,.jpeg,.gif,.bmp' });
  const backdrop = h('div', { class: 'backdrop' });
  let bannerUrl: string | null = null;
  let backdropUrl: string | null = null;
  let closed = false;

  // The selected song's sample plays after a moment's rest on it, and loops.
  let previewToken = 0;
  let previewTimer = 0;
  let previewing = false;
  const stopPreview = (): void => {
    previewToken++;
    window.clearTimeout(previewTimer);
    if (previewing) app.engine?.stopMusic(0.25);
    previewing = false;
  };
  const schedulePreview = (song: SongRecord | null): void => {
    stopPreview();
    // Only once something has asked for audio (the title screen's key press): a preview must
    // not be what creates it, as the browser would refuse.
    if (!song || !song.music || !app.audioAsked) return;
    const token = previewToken;
    const live = (): boolean => token === previewToken && !closed;
    previewTimer = window.setTimeout(() => {
      void app.exclusive(async () => {
        if (!live()) return;
        let audio = previewCache?.id === song.id ? previewCache.audio : null;
        if (!audio) {
          const file = await songFile(song, song.music);
          if (!file || !live()) return;
          audio = await decodeAudioFile(new Uint8Array(await file.arrayBuffer()), file.name);
          previewCache = { id: song.id, audio };
        }
        const audioEngine = await app.audio();
        if (!live()) return;
        const info = await audioEngine.loadMusic(audio);
        if (!live()) return;
        const length = song.sampleLength && song.sampleLength > 1 ? song.sampleLength : 12;
        const start = Math.max(0, Math.min(song.sampleStart && song.sampleStart > 0 ? song.sampleStart : info.seconds * 0.3, info.seconds - length));
        const loop = (): void => {
          if (!live()) return;
          audioEngine.playMusic({ fromSeconds: start, delaySeconds: 0.05, gain: 0.7 });
          previewing = true;
          previewTimer = window.setTimeout(() => {
            if (!live()) return;
            audioEngine.stopMusic(1);
            previewTimer = window.setTimeout(loop, 1300);
          }, Math.max(1, length - 1) * 1000);
        };
        loop();
      }).catch(() => undefined);
    }, 450);
  };

  const visible = (): SongRecord[] => songs.filter((song) => playable(song).length > 0 && matches(song, query));
  const selected = (): SongRecord | null => songs.find((s) => s.id === selectedId) ?? null;

  const say = (text: string): void => {
    notice = text;
    status.hidden = false;
    status.textContent = text;
  };

  async function doImport(files: { path: string; file: File }[]): Promise<void> {
    if (files.length === 0) return;
    say('Importing…');
    try {
      const result = await importFiles(files, (done, total, name) => say(`Importing ${done + 1} of ${total}: ${name}`));
      songs = await listSongs();
      const added = result.added.length - result.replaced;
      const parts = [];
      if (added > 0) parts.push(`${added} song${added === 1 ? '' : 's'} added`);
      if (result.replaced > 0) parts.push(`${result.replaced} replaced`);
      if (result.problems.length > 0) parts.push(result.problems.slice(0, 3).join('; ') + (result.problems.length > 3 ? `; and ${result.problems.length - 3} more` : ''));
      say(parts.join('. ') || 'Nothing was imported.');
      if (result.added[0]) selectedId = result.added[0].id;
    } catch (error) {
      say(`Import failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!closed) render();
  }

  folderInput.addEventListener('change', () => void doImport(pickedFiles(folderInput.files)));
  filesInput.addEventListener('change', () => void doImport(pickedFiles(filesInput.files)));
  search.addEventListener('input', () => {
    query = search.value;
    render();
  });

  function renderList(): void {
    const shown = visible();
    if (!shown.some((s) => s.id === selectedId)) selectedId = shown[0]?.id ?? null;
    const rows: HTMLElement[] = [];
    let pack: string | null = null;
    for (const song of shown) {
      if (song.pack !== pack) {
        pack = song.pack;
        rows.push(h('div', { class: 'pack' }, pack || 'Songs'));
      }
      const levels = playable(song);
      rows.push(
        h(
          'div',
          {
            class: `song${song.id === selectedId ? ' selected' : ''}`,
            role: 'option',
            'aria-selected': song.id === selectedId,
            'data-id': song.id,
            onclick: () => select(song.id),
            ondblclick: () => void start(),
          },
          h('span', { class: 'song-title' }, song.title, song.subtitle ? h('span', { class: 'song-sub' }, ` ${song.subtitle}`) : null),
          h('span', { class: 'song-artist' }, song.artist),
          h('span', { class: 'song-levels' }, levels.map((c) => h('span', { class: `level d-${c.difficulty.toLowerCase()}` }, String(c.meter)))),
        ),
      );
    }
    list.replaceChildren(...rows);
    list.querySelector('.selected')?.scrollIntoView({ block: 'nearest' });
  }

  async function renderDetail(): Promise<void> {
    const song = selected();
    if (bannerUrl) URL.revokeObjectURL(bannerUrl);
    bannerUrl = null;
    if (!song) {
      detail.replaceChildren();
      backdrop.classList.remove('shown');
      return;
    }
    const levels = playable(song);
    if (!levels.some((c) => c.key === selectedChartKey)) {
      // Stay on the difficulty last played when the song has it.
      selectedChartKey = (levels.find((c) => c.difficulty === selectedChartKey?.split('/')[1]) ?? levels[Math.min(1, levels.length - 1)])?.key ?? null;
    }
    const [scores, picture, wide] = await Promise.all([
      bestScores(song.id).catch(() => new Map<string, ScoreRecord>()),
      songFile(song, song.banner || song.background),
      songFile(song, song.background || song.banner),
    ]);
    if (closed || selected() !== song) return;
    if (picture) bannerUrl = URL.createObjectURL(picture);
    // The song's picture, out of focus, behind the whole screen.
    if (backdropUrl) URL.revokeObjectURL(backdropUrl);
    backdropUrl = wide ? URL.createObjectURL(wide) : null;
    backdrop.style.backgroundImage = backdropUrl ? `url("${backdropUrl}")` : '';
    backdrop.classList.toggle('shown', backdropUrl !== null);
    const bpm = song.bpmMin === song.bpmMax ? `${song.bpmMax} BPM` : `${song.bpmMin}–${song.bpmMax} BPM`;
    detail.replaceChildren(
      bannerUrl ? h('img', { class: 'banner', src: bannerUrl, alt: '' }) : h('div', { class: 'banner banner-none', 'aria-hidden': 'true' }, song.title),
      h('h2', {}, song.title, song.subtitle ? h('span', { class: 'song-sub' }, ` ${song.subtitle}`) : null),
      h('p', { class: 'sub' }, [song.artist, bpm, song.music ? null : 'no music file'].filter(Boolean).join(' · ')),
      h(
        'div',
        { class: 'charts', role: 'radiogroup', 'aria-label': 'Difficulty' },
        levels.map((c) => {
          const best = scores.get(c.key);
          return h(
            'button',
            {
              class: `chart d-${c.difficulty.toLowerCase()}${c.key === selectedChartKey ? ' selected' : ''}`,
              role: 'radio',
              'aria-checked': c.key === selectedChartKey,
              onclick: () => {
                selectedChartKey = c.key;
                void renderDetail();
              },
            },
            h('span', { class: 'chart-name' }, c.difficulty),
            h('span', { class: 'chart-meter' }, String(c.meter)),
            h('span', { class: 'chart-best' }, best ? (best.failed ? 'Failed' : `${best.grade} ${best.percent.toFixed(2)}%`) : '—'),
          );
        }),
      ),
      h(
        'div',
        { class: 'actions' },
        h('button', { class: 'primary play', onclick: () => void start() }, app.settings.autoplay ? 'Watch (autoplay)' : 'Play'),
        h(
          'button',
          {
            class: 'quiet',
            onclick: async () => {
              if (!confirm(`Remove "${song.title}" and its scores from this browser?`)) return;
              await deleteSong(song);
              songs = await listSongs();
              say(`Removed ${song.title}.`);
              render();
            },
          },
          'Remove',
        ),
      ),
      h('p', { class: 'note' }, `${app.settings.speed}${app.settings.reverse ? ', reverse' : ''}${app.settings.failOff ? ', fail off' : ''} · offset ${app.settings.globalOffsetMs} ms · ${megabytes(song.bytes)}`),
    );
  }

  function select(id: string): void {
    if (id !== selectedId) app.sfx('move');
    selectedId = id;
    renderList();
    void renderDetail();
    schedulePreview(selected());
  }

  async function start(): Promise<void> {
    const song = selected();
    const chart = song && playable(song).find((c) => c.key === selectedChartKey);
    if (!song || !chart) return;
    void app.audio(); // within the click or key press, so that the browser lets audio start
    stopPreview();
    app.sfx('confirm');
    app.show(await playScreen(app, song, chart));
  }

  function openSocial(): void {
    app.show(
      socialScreen(
        () => app.show(libraryScreen()),
        (added) => {
          void listSongs().then((loaded) => {
            songs = loaded;
            say(`${added} social song${added === 1 ? '' : 's'} imported.`);
            render();
          });
        },
      ),
    );
  }

  const importButtons = [
    h('button', { class: 'primary', onclick: openSocial }, 'Social packs'),
    h('button', { onclick: () => folderInput.click() }, 'Add a folder'),
    h('button', { onclick: () => filesInput.click() }, 'Add files or a zip'),
  ];
  const empty = h(
    'div',
    { class: 'empty' },
    h('h2', {}, 'No songs yet'),
    h('p', {}, 'Add a StepMania song folder, a pack folder, or a zip of either. You can also drop them anywhere on this page. Songs are copied into this browser\'s own storage and never leave your machine.'),
    h('div', { class: 'actions' }, h('button', { class: 'primary', onclick: openSocial }, 'Browse social packs'), h('button', { onclick: () => folderInput.click() }, 'Add a folder'), h('button', { onclick: () => filesInput.click() }, 'Add files or a zip')),
  );
  const body = h('div', { class: 'library-body' }, list, detail);

  function render(): void {
    const any = songs.some((s) => playable(s).length > 0);
    body.hidden = !any;
    empty.hidden = any;
    search.hidden = !any;
    renderList();
    void renderDetail();
  }

  const root = h(
    'div',
    { class: 'screen library' },
    backdrop,
    h('header', { class: 'bar' }, h('span', { class: 'wordmark' }, 'FeetOnFire'), search, h('span', { class: 'spacer' }), importButtons, h('button', { onclick: () => app.show(settingsScreen(app)) }, 'Settings')),
    status,
    empty,
    body,
    h('footer', { class: 'hints' }, hint('↑↓', 'Song'), hint('←→', 'Difficulty'), hint('Enter', 'Play'), hint('/', 'Search'), hint('Esc', 'Pause in game')),
    folderInput,
    filesInput,
  );

  root.addEventListener('dragover', (e) => {
    e.preventDefault();
    root.classList.add('dropping');
  });
  root.addEventListener('dragleave', () => root.classList.remove('dropping'));
  root.addEventListener('drop', (e) => {
    e.preventDefault();
    root.classList.remove('dropping');
    if (e.dataTransfer) void droppedFiles(e.dataTransfer).then(doImport);
  });

  render();
  void listSongs().then((loaded) => {
    songs = loaded;
    if (closed) return;
    render();
    schedulePreview(selected());
  });

  return {
    root,
    onKey(e) {
      if (document.activeElement === search && e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Enter') return false;
      const shown = visible();
      const at = shown.findIndex((s) => s.id === selectedId);
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        const next = shown[Math.min(shown.length - 1, Math.max(0, at + (e.key === 'ArrowDown' ? 1 : -1)))];
        if (next) select(next.id);
        return true;
      }
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        const song = selected();
        if (!song) return false;
        const levels = playable(song);
        const i = levels.findIndex((c) => c.key === selectedChartKey);
        const next = levels[Math.min(levels.length - 1, Math.max(0, i + (e.key === 'ArrowRight' ? 1 : -1)))];
        if (next && next.key !== selectedChartKey) {
          app.sfx('move');
          selectedChartKey = next.key;
          void renderDetail();
        }
        return true;
      }
      if (e.key === 'Enter' && !(document.activeElement instanceof HTMLButtonElement)) {
        void start();
        return true;
      }
      if (e.key === '/' && document.activeElement !== search) {
        search.focus();
        return true;
      }
      return false;
    },
    close() {
      stopPreview();
      closed = true;
      if (bannerUrl) URL.revokeObjectURL(bannerUrl);
      if (backdropUrl) URL.revokeObjectURL(backdropUrl);
    },
  };
}

window.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (current?.onKey?.(e)) e.preventDefault();
});

app.input.start();
void app.input.openKnownHid();
app.show(titleScreen());

// For the end-to-end test.
(window as unknown as { __app: unknown }).__app = {
  app,
  get songs() {
    return songs;
  },
  get screen() {
    return current?.root.className ?? '';
  },
};
