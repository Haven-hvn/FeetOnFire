// Settings: play options, the offset and its tap calibration, and which controls are which panels.

import { DEFAULT_BINDINGS, describeControl, PANEL_NAMES } from '../game/bindings.ts';
import { parseSpeed } from '../game/field.ts';
import { hidApi } from '../game/input.ts';
import type { App } from './context.ts';
import { CLICK_COUNT, CLICK_FIRST_SECONDS, CLICK_INTERVAL_SECONDS, clickTrack, summarizeTaps, tapError } from './sounds.ts';
import { requestPersistence, storageState } from './store.ts';
import { h, megabytes, type Screen } from './ui.ts';

/** Reported output latency above this (ms) usually means Bluetooth: say so. */
const HIGH_LATENCY_MS = 50;

export function settingsScreen(app: App): Screen {
  const s = app.settings;
  let capture: { track: number; note: HTMLElement } | null = null;
  let stopCalibration: (() => void) | null = null;

  const changed = (): void => app.saveSettings();

  // ------------------------------------------------------------- play options
  const speed = h('input', { type: 'text', value: s.speed, size: 6, 'aria-label': 'Speed' });
  const speedNote = h('span', { class: 'note' });
  speed.addEventListener('change', () => {
    if (parseSpeed(speed.value)) {
      s.speed = speed.value.trim();
      speedNote.textContent = '';
      changed();
    } else {
      speedNote.textContent = 'Use 2x, C450 or M450.';
    }
  });
  const check = (key: 'reverse' | 'failOff' | 'autoplay', label: string): HTMLElement => {
    const box = h('input', { type: 'checkbox', checked: s[key] });
    box.addEventListener('change', () => {
      s[key] = box.checked;
      changed();
    });
    return h('label', { class: 'check' }, box, label);
  };
  const dim = h('input', { type: 'range', min: 0, max: 1, step: 0.05, value: s.backgroundDim });
  dim.addEventListener('input', () => {
    s.backgroundDim = Number(dim.value);
    changed();
  });

  // ------------------------------------------------------------------ timing
  const offset = h('input', { type: 'number', value: s.globalOffsetMs, step: 1, min: -1000, max: 1000 });
  offset.addEventListener('change', () => {
    s.globalOffsetMs = Math.min(1000, Math.max(-1000, Math.round(Number(offset.value) || 0)));
    offset.value = String(s.globalOffsetMs);
    changed();
  });
  const visual = h('input', { type: 'number', value: s.visualLeadMs, step: 1, min: -500, max: 500 });
  visual.addEventListener('change', () => {
    s.visualLeadMs = Math.min(500, Math.max(-500, Math.round(Number(visual.value) || 0)));
    visual.value = String(s.visualLeadMs);
    changed();
  });
  const calibrationOut = h('div', { class: 'calibration', hidden: true });
  const latencyNote = h('p', { class: 'note' });
  const showLatency = (): void => {
    const engine = app.engine;
    if (!engine) return;
    const ms = (engine.context.baseLatency + engine.context.outputLatency) * 1000;
    latencyNote.textContent =
      ms > HIGH_LATENCY_MS
        ? `Your audio output reports ${ms.toFixed(0)} ms of delay, which is typical of Bluetooth. The game allows for what is reported, but wireless audio often has more: use "Tap to set", or switch to wired audio.`
        : `Your audio output reports ${ms.toFixed(0)} ms of delay; the game allows for it.`;
    latencyNote.classList.toggle('warn', ms > HIGH_LATENCY_MS);
  };
  showLatency();

  async function calibrate(): Promise<void> {
    if (stopCalibration) return;
    const engine = await app.audio();
    showLatency();
    await app.exclusive(async () => {
      await engine.loadMusic(clickTrack(engine.sampleRate));
      engine.playMusic({ fromSeconds: 0, delaySeconds: 0.1 });
    });
    const errors: number[] = [];
    const status = h('p', {}, 'Listen for a moment, then tap any key in time with the clicks.');
    const cancel = h('button', { onclick: () => finish(false) }, 'Cancel');
    calibrationOut.replaceChildren(status, cancel);
    calibrationOut.hidden = false;

    const tap = (timeStamp: number): void => {
      const seconds = engine.musicSecondsAt(timeStamp);
      if (seconds === null) return;
      const error = tapError(seconds);
      // The first clicks are for finding the beat; a tap far from any click is a slip.
      if (error === null || seconds < CLICK_FIRST_SECONDS + 3.5 * CLICK_INTERVAL_SECONDS || Math.abs(error) > 200) return;
      errors.push(error);
      status.textContent = `${errors.length} taps. Keep going until the clicks stop.`;
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.repeat || e.key === 'Escape' || e.key === 'Tab') return;
      e.preventDefault();
      tap(e.timeStamp);
    };
    const before = app.input.onControl;
    app.input.onControl = (control, down, timeStamp) => {
      if (down && !control.startsWith('key:')) tap(timeStamp);
    };
    app.input.refresh();
    window.addEventListener('keydown', onKey, true);
    const timer = window.setTimeout(() => finish(true), (CLICK_FIRST_SECONDS + CLICK_COUNT * CLICK_INTERVAL_SECONDS + 0.5) * 1000);

    const finish = (ended: boolean): void => {
      window.clearTimeout(timer);
      window.removeEventListener('keydown', onKey, true);
      app.input.onControl = before;
      app.input.refresh();
      engine.stopMusic(0.05);
      stopCalibration = null;
      const summary = summarizeTaps(errors);
      if (!ended) {
        calibrationOut.hidden = true;
        return;
      }
      if (!summary || summary.n < 8) {
        calibrationOut.replaceChildren(h('p', {}, `Only ${summary?.n ?? 0} taps landed near a click; at least 8 are needed.`), h('button', { onclick: () => void calibrate() }, 'Try again'));
        return;
      }
      const suggested = -Math.round(summary.median);
      const steady = summary.spread <= 25;
      calibrationOut.replaceChildren(
        h(
          'p',
          {},
          `You tapped ${Math.abs(summary.median).toFixed(0)} ms ${summary.median >= 0 ? 'after' : 'before'} the clicks on average over ${summary.n} taps (steady to about ±${summary.spread.toFixed(0)} ms).`,
          steady ? '' : ' That is quite uneven: the result may not be worth much.',
        ),
        h(
          'button',
          {
            class: 'primary',
            onclick: () => {
              s.globalOffsetMs = suggested;
              offset.value = String(suggested);
              changed();
              calibrationOut.replaceChildren(h('p', {}, `Offset set to ${suggested} ms.`));
            },
          },
          `Set offset to ${suggested} ms`,
        ),
        h('button', { onclick: () => void calibrate() }, 'Try again'),
        h('button', { onclick: () => (calibrationOut.hidden = true) }, 'Leave it'),
      );
    };
    stopCalibration = () => finish(false);
  }

  // ----------------------------------------------------------------- controls
  const mapping = h('div', { class: 'mapping' });
  const hidNote = h('span', { class: 'note' });
  const renderMapping = (): void => {
    mapping.replaceChildren(
      ...PANEL_NAMES.map((name, track) => {
        const controls = Object.entries(s.bindings).filter(([, t]) => t === track);
        const note = h('span', { class: 'note' });
        return h(
          'div',
          { class: 'map-row' },
          h('span', { class: 'panel-name' }, name),
          h(
            'span',
            { class: 'chips' },
            controls.map(([control]) =>
              h(
                'span',
                { class: 'chip' },
                describeControl(control),
                h(
                  'button',
                  {
                    class: 'chip-x',
                    title: 'Remove',
                    'aria-label': `Remove ${describeControl(control)}`,
                    onclick: () => {
                      delete s.bindings[control];
                      commitBindings();
                    },
                  },
                  '×',
                ),
              ),
            ),
          ),
          h(
            'button',
            {
              onclick: () => {
                capture = { track, note };
                note.textContent = 'Press a key, pad button or panel… (Esc cancels)';
                app.input.refresh();
              },
            },
            'Add',
          ),
          note,
        );
      }),
    );
    hidNote.textContent = app.input.hidDevices.length > 0 ? `Connected: ${app.input.hidDevices.join(', ')}` : '';
  };
  const commitBindings = (): void => {
    app.input.setBindings(s.bindings);
    changed();
    renderMapping();
  };
  const before = app.input.onControl;
  app.input.onControl = (control, down) => {
    if (!capture || !down) return;
    if (control === 'key:Escape') {
      capture = null;
      renderMapping();
      return;
    }
    s.bindings[control] = capture.track; // a control stands for one panel: this moves it
    capture = null;
    commitBindings();
  };
  app.input.refresh();
  renderMapping();

  // ------------------------------------------------------------------ storage
  const storage = h('p', { class: 'note' }, '…');
  const showStorage = async (): Promise<void> => {
    const state = await storageState();
    storage.replaceChildren(
      `Songs use ${megabytes(state.usedBytes)} of ${megabytes(state.quotaBytes)} this browser allows. `,
      state.persistent
        ? 'The browser has agreed to keep them.'
        : h('button', { onclick: () => void requestPersistence().then(showStorage) }, 'Ask the browser to keep them'),
    );
  };
  void showStorage();

  const root = h(
    'div',
    { class: 'screen settings' },
    h(
      'header',
      { class: 'bar' },
      h(
        'button',
        {
          class: 'back',
          onclick: () => {
            app.sfx('back');
            app.home();
          },
        },
        '← Back',
      ),
      h('h1', {}, 'Settings'),
    ),
    h(
      'div',
      { class: 'settings-body' },
      h(
        'section',
        {},
        h('h2', {}, 'Play'),
        h('div', { class: 'field' }, h('label', {}, 'Speed ', speed), speedNote),
        h('p', { class: 'note' }, '2x: twice the song\'s tempo. C450: a constant 450 BPM. M450: the fastest part at 450 BPM.'),
        h('div', { class: 'field' }, check('reverse', 'Reverse scroll'), check('failOff', 'Fail off'), check('autoplay', 'Autoplay (scores are not kept)')),
        h('div', { class: 'field' }, h('label', {}, 'Background brightness ', dim)),
      ),
      h(
        'section',
        {},
        h('h2', {}, 'Timing'),
        h('div', { class: 'field' }, h('label', {}, 'Offset ', offset, ' ms'), h('button', { onclick: () => void calibrate() }, 'Tap to set')),
        h('p', { class: 'note' }, 'If steps on the beat are judged late, make the offset more negative; if early, more positive. It depends on your speakers or headphones, not on you: set it once per setup.'),
        latencyNote,
        calibrationOut,
        h('div', { class: 'field' }, h('label', {}, 'Draw ahead ', visual, ' ms')),
        h('p', { class: 'note' }, 'Moves the arrows only. Raise it if the arrows reach the targets after the beat is heard (a slow display).'),
      ),
      h(
        'section',
        {},
        h('h2', {}, 'Controls'),
        mapping,
        h(
          'div',
          { class: 'field' },
          hidApi() ? h('button', { onclick: () => void app.input.requestHid().then(renderMapping, () => undefined) }, 'Connect a pad (USB HID)…') : null,
          h(
            'button',
            {
              onclick: () => {
                s.bindings = { ...DEFAULT_BINDINGS };
                commitBindings();
              },
            },
            'Reset to the keyboard defaults',
          ),
          hidNote,
        ),
        h('p', { class: 'note' }, 'Gamepads work once a button on them has been pressed. Pad input has been written to the specifications but not yet tried on a real pad.'),
      ),
      h('section', {}, h('h2', {}, 'Storage'), storage),
    ),
  );

  return {
    root,
    onKey(e) {
      if (e.key !== 'Escape') return false;
      if (capture) return true; // the router's handler takes it
      if (stopCalibration) stopCalibration();
      else app.home();
      return true;
    },
    close() {
      stopCalibration?.();
      app.input.onControl = before;
      app.input.refresh();
    },
  };
}
