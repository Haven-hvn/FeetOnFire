// Playing a song from the library: loading, the game itself with its pause menu, and the
// results screen.

import { decodeAudioFile } from '../audio/decode.ts';
import type { DecodedAudio } from '../audio/pcm.ts';
import { parseSpeed } from '../game/field.ts';
import type { Results } from '../game/protocol.ts';
import { GameSession, type SessionReport } from '../game/session.ts';
import type { App } from './context.ts';
import type { ChartRecord, SongRecord } from './library.ts';
import { SFX } from './sounds.ts';
import { addScore, bestScores, songFile } from './store.ts';
import { h, type Screen } from './ui.ts';

const EV_TAP_JUDGMENT = 1;
/** TapNoteScore W5: the least that is a hit. */
const TNS_W5 = 5;

export async function playScreen(app: App, song: SongRecord, chart: ChartRecord): Promise<Screen> {
  const stage = h('div', { class: 'stage' });
  const message = h('div', { class: 'overlay' }, h('div', { class: 'overlay-box' }, h('p', { class: 'loading' }, `Loading ${song.title}…`)));
  const root = h('div', { class: 'screen game' }, stage, message);
  let session: GameSession | null = null;
  let closed = false;
  let leaving = false;

  const fail = (text: string): void => {
    message.replaceChildren(h('div', { class: 'overlay-box' }, h('p', {}, text), h('button', { class: 'primary', onclick: () => app.home() }, 'Back')));
    message.hidden = false;
  };

  const end = async (finished: boolean): Promise<void> => {
    if (leaving || !session) return;
    leaving = true;
    const report = await session.stop(finished ? 0.8 : 0.2);
    session = null;
    if (closed) return;
    if (!report) return app.home();
    app.show(await resultsScreen(app, song, chart, report, finished));
  };

  const pauseMenu = (): void => {
    if (!session || session.paused || leaving) return;
    session.pause();
    const resume = h('button', { class: 'primary', onclick: () => unpause() }, 'Resume');
    message.replaceChildren(
      h(
        'div',
        { class: 'overlay-box' },
        h('h2', {}, 'Paused'),
        resume,
        h('button', { onclick: () => void restart() }, 'Restart'),
        h('button', { onclick: () => void end(false) }, 'End song'),
        h('button', { onclick: () => void quit() }, 'Quit to song list'),
      ),
    );
    message.hidden = false;
    resume.focus();
  };
  const unpause = (): void => {
    message.hidden = true;
    session?.resume();
  };
  const quit = async (): Promise<void> => {
    app.sfx('back');
    leaving = true;
    await session?.stop(0.1);
    session = null;
    app.home();
  };
  const restart = async (): Promise<void> => {
    leaving = true;
    await session?.stop(0.1);
    session = null;
    app.show(await playScreen(app, song, chart));
  };

  // Loading runs after the screen is up, so that the message shows.
  void (async () => {
    try {
      const engine = await app.audio();
      const simfile = await songFile(song, song.simfile);
      if (!simfile) throw new Error('The song\'s files are no longer in storage. Import it again.');
      const musicFile = await songFile(song, song.music);
      let audio: DecodedAudio;
      if (musicFile) {
        audio = await decodeAudioFile(new Uint8Array(await musicFile.arrayBuffer()), musicFile.name);
      } else {
        audio = { sampleRate: engine.sampleRate, channels: [new Float32Array(1)], frames: 1, format: 'wav', decoder: 'wav', notes: [] };
      }
      if (closed) return;
      // After anything else that is loading music (a song preview on its way), so that this is the music that stays.
      await app.exclusive(() => engine.loadMusic(audio));
      if (closed) return;
      const speed = parseSpeed(app.settings.speed) ?? { mode: 'x' as const, value: 2 };
      session = await GameSession.start(stage, engine, {
        simfile: new Uint8Array(await simfile.arrayBuffer()),
        format: song.format,
        path: song.simfile,
        chartIndex: chart.index,
        input: app.input,
        mineSound: SFX.mine,
        settings: {
          log: true, // the results screen shows where the hits fell
          autoplay: app.settings.autoplay,
          failType: app.settings.failOff ? 'off' : 'immediate',
          globalOffsetMs: app.settings.globalOffsetMs,
          visualLeadMs: app.settings.visualLeadMs,
          scroll: { ...speed, reverse: app.settings.reverse },
        },
      });
      if (closed) {
        await session.stop(0);
        session = null;
        return;
      }
      session.onFinished = () => void end(true);
      session.onError = (text) => fail(`The game stopped: ${text}`);
      message.hidden = true;
      const picture = await songFile(song, song.background);
      if (picture && session) {
        try {
          session.setBackground(await createImageBitmap(picture), app.settings.backgroundDim);
        } catch {
          // Not a picture the browser can read: no background.
        }
      }
    } catch (error) {
      if (!closed) fail(error instanceof Error ? error.message : String(error));
    }
  })();

  const onBlur = (): void => pauseMenu();
  window.addEventListener('blur', onBlur);

  return {
    root,
    onKey(e) {
      if (e.key !== 'Escape') return false;
      if (!session) app.home();
      else if (session.paused) unpause();
      else pauseMenu();
      return true;
    },
    close() {
      closed = true;
      window.removeEventListener('blur', onBlur);
      void session?.stop(0.1);
      session = null;
    },
  };
}

/** Where the hits fell around the beat, and what that says about the offset. */
function histogram(app: App, report: SessionReport, autoplay: boolean): HTMLElement | null {
  const offsets = (report.log?.events ?? []).filter((e) => e[0] === EV_TAP_JUDGMENT && e[3]! >= TNS_W5).map((e) => e[4]! * 1000);
  if (autoplay || offsets.length < 8) return null;
  const RANGE = 180;
  const BINS = 45;
  const counts = new Array<number>(BINS).fill(0);
  for (const ms of offsets) counts[Math.min(BINS - 1, Math.max(0, Math.floor(((ms + RANGE) / (2 * RANGE)) * BINS)))]!++;
  const most = Math.max(...counts);
  const sorted = [...offsets].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)]!;
  const bars = h(
    'div',
    { class: 'bars', role: 'img', 'aria-label': `Hit timing: median ${Math.abs(median).toFixed(0)} ms ${median >= 0 ? 'late' : 'early'}` },
    counts.map((n) => {
      const bar = h('div', { class: 'bar-hit' });
      bar.style.height = `${(n / most) * 100}%`;
      return bar;
    }),
  );
  const out = h('div', { class: 'histogram' }, bars, h('div', { class: 'axis' }, h('span', {}, 'early'), h('span', {}, `median ${Math.abs(median).toFixed(0)} ms ${median >= 0 ? 'late' : 'early'}`), h('span', {}, 'late')));
  // A steady lean one way is the setup, not the player: offer to take it out.
  if (Math.abs(median) >= 12 && offsets.length >= 30) {
    const change = -Math.round(median);
    const note = h('p', { class: 'note' }, `Your hits lean ${median >= 0 ? 'late' : 'early'}. If that is how it felt, the timing offset is probably off by about ${Math.abs(change)} ms. `);
    const apply = h(
      'button',
      {
        onclick: () => {
          app.settings.globalOffsetMs = Math.max(-1000, Math.min(1000, app.settings.globalOffsetMs + change));
          app.saveSettings();
          note.textContent = `Offset is now ${app.settings.globalOffsetMs} ms.`;
        },
      },
      `Change offset by ${change > 0 ? '+' : ''}${change} ms`,
    );
    note.append(apply);
    out.append(note);
  }
  return out;
}

const JUDGEMENTS: [keyof Results, string][] = [
  ['w1', 'Flawless'],
  ['w2', 'Perfect'],
  ['w3', 'Great'],
  ['w4', 'Good'],
  ['w5', 'Boo'],
  ['miss', 'Miss'],
];

export async function resultsScreen(app: App, song: SongRecord, chart: ChartRecord, report: SessionReport, finished: boolean): Promise<Screen> {
  const r = report.results;
  const t = report.telemetry;
  // A score counts when the song was played to the end (or failed) by a person.
  const counts = !r.autoplay && (finished || r.failed);
  let best: number | null = null;
  if (counts) {
    const before = (await bestScores(song.id)).get(chart.key);
    best = before && !before.failed ? before.percent : null;
    await addScore({ songId: song.id, chartKey: chart.key, percent: r.percent, grade: r.failed ? 'Failed' : r.grade, score: r.score, maxCombo: r.maxCombo, failed: r.failed, date: Date.now() });
  }
  const record = counts && !r.failed && (best === null || r.percent > best);
  const grade = r.failed ? 'Failed' : finished ? r.grade : '—';
  const again = h('button', { class: 'primary', onclick: async () => app.show(await playScreen(app, song, chart)) }, 'Play again');
  // The percentage counts up to its value, unless the player has asked for less motion.
  const percentText = h('span', {}, `${r.percent.toFixed(2)}%`);
  if (!matchMedia('(prefers-reduced-motion: reduce)').matches && r.percent > 0) {
    const began = performance.now();
    const tick = (now: number): void => {
      const t = Math.min(1, (now - began) / 900);
      percentText.textContent = `${(r.percent * (1 - Math.pow(1 - t, 3))).toFixed(2)}%`;
      if (t < 1) requestAnimationFrame(tick);
      else percentText.textContent = `${r.percent.toFixed(2)}%`;
    };
    percentText.textContent = '0.00%';
    requestAnimationFrame(tick);
  }
  const root = h(
    'div',
    { class: 'screen results' },
    h(
      'div',
      { class: 'results-card' },
      h('p', { class: 'eyebrow' }, r.autoplay ? 'Autoplay' : finished ? 'Song complete' : r.failed ? 'Failed' : 'Stopped before the end'),
      h('h1', {}, song.title),
      h('p', { class: 'sub' }, `${song.artist} · ${chart.difficulty} ${chart.meter}`),
      h('div', { class: 'grade-row' }, h('div', { class: `grade grade-${grade.toLowerCase()}` }, grade), h('div', { class: 'percent' }, percentText, record ? h('span', { class: 'record' }, best === null ? 'First clear' : 'New best') : null)),
      h(
        'dl',
        { class: 'counts' },
        JUDGEMENTS.map(([key, label]) => h('div', { class: `count count-${key}` }, h('dt', {}, label), h('dd', {}, String(r[key])))),
      ),
      h(
        'dl',
        { class: 'facts' },
        h('div', {}, h('dt', {}, 'Max combo'), h('dd', {}, String(r.maxCombo))),
        h('div', {}, h('dt', {}, 'Holds'), h('dd', {}, `${r.held} / ${r.holds + r.rolls}`)),
        h('div', {}, h('dt', {}, 'Mines hit'), h('dd', {}, String(r.minesHit))),
        h('div', {}, h('dt', {}, 'Score'), h('dd', {}, r.score.toLocaleString('en-US'))),
      ),
      histogram(app, report, r.autoplay),
      h('div', { class: 'actions' }, again, h('button', { onclick: () => app.home() }, 'Song list')),
      h(
        'details',
        { class: 'timing' },
        h('summary', {}, 'Timing of this run'),
        h(
          'pre',
          {},
          [
            `Frames            ${t.frames} at ${t.refreshHz ?? '?'} Hz, ${t.onTimePercent ?? '?'} % on time (${t.lateFrames} late)`,
            `Frame CPU ms      ${JSON.stringify(t.frameCpuMs)}`,
            `Input to frame ms ${JSON.stringify(t.inputToFrameMs)}`,
            `Inputs            ${t.inputs} (${t.lateInputs} late, ${t.ringDropped} dropped)`,
            `Worker clock      ${t.clockOffsetErrorMs ?? '?'} ms off through timeOrigin, corrected`,
            `Audio clock       ${JSON.stringify(app.engine?.clockReport() ?? null)}`,
            `Renderer          ${t.renderer}`,
          ].join('\n'),
        ),
      ),
    ),
  );
  queueMicrotask(() => again.focus({ preventScroll: true }));
  return {
    root,
    onKey(e) {
      if (e.key !== 'Escape') return false;
      app.home();
      return true;
    },
  };
}
