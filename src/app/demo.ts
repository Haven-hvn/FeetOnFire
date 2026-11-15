// The song bundled with the game. On the first visit it is copied into the library so
// there is something to play, the way StepMania ships with a song in the box.
//
// "Goin' Under" by NegaRen, charts by Fraxtil, from StepMania 5. The files live in
// public/demo/ and Vite copies them into dist/demo/. See public/demo/CREDITS.md.

import { importFiles } from './store.ts';

const DEMO_DIR = "demo/StepMania 5/Goin' Under";
const DEMO_FILES = ["Goin' Under.ssc", "Goin' Under.ogg", "bn.png", "bg.png"];
const SEEDED_KEY = 'dance.demoSeeded.v1';

/** True once the bundled song has been copied into this browser's library. */
export function demoSeeded(): boolean {
  try {
    return localStorage.getItem(SEEDED_KEY) === '1';
  } catch {
    return false;
  }
}

/** Copies the bundled song into the library. Throws if a file cannot be loaded. */
export async function seedDemo(): Promise<void> {
  const files = await Promise.all(
    DEMO_FILES.map(async (name) => {
      // Vite serves the public directory under its base (/dist/).
      const response = await fetch(encodeURI(`/dist/${DEMO_DIR}/${name}`));
      if (!response.ok) throw new Error(`the demo song could not be loaded (${response.status})`);
      return { path: `${DEMO_DIR}/${name}`, file: await response.blob() };
    }),
  );
  await importFiles(files);
  try {
    localStorage.setItem(SEEDED_KEY, '1');
  } catch {
    // Storage blocked: the demo will be offered again next visit.
  }
}