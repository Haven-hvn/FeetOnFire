// What the app's screens share.

import type { AudioEngine } from '../audio/engine.ts';
import type { InputRouter } from '../game/input.ts';
import type { SfxName } from './sounds.ts';
import type { Settings } from './store.ts';
import type { Screen } from './ui.ts';

export interface App {
  settings: Settings;
  readonly input: InputRouter;
  /** The one audio engine of the visit; created on first use, which must be a click or key press. */
  audio(): Promise<AudioEngine>;
  /** True once audio() has been called: the engine exists or is on its way. */
  readonly audioAsked: boolean;
  /** The engine if it has been created. */
  readonly engine: AudioEngine | null;
  /** Runs `task` when no other task that loads or starts music is running: one at a time, in order. */
  exclusive<T>(task: () => Promise<T>): Promise<T>;
  /** Plays a menu sound, if audio has been started. */
  sfx(name: SfxName): void;
  show(screen: Screen): void;
  home(): void;
  saveSettings(): void;
}
