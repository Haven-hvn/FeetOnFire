import { defineConfig } from 'vite';

// One build emits every page the dev server serves:
//   app/index.html      -> /dist/app/main.js
//   lab/index.html      -> /dist/lab/main.js
//   lab/play/index.html -> /dist/game/play-page.js
// Workers and AudioWorklets referenced through `new URL(..., import.meta.url)` are emitted
// alongside their entry and the URLs are rewritten by Vite.
export default defineConfig({
  base: '/dist/',
  build: {
    target: 'es2022',
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        app: 'src/app/main.ts',
        lab: 'src/lab/main.ts',
        play: 'src/game/play-page.ts',
      },
      output: {
        // Vite's dynamic-import preload helper is emitted into the entry chunk, so every lazy
        // chunk imports it back as "./main.js". The deploy version-busts app/main.js (?v=…),
        // which makes that bare import a second URL: the entry is evaluated again and the app
        // boots over itself. Keep the helper in its own chunk so nothing imports the entry.
        manualChunks(id) {
          if (id.includes('vite/preload-helper')) return 'preload-helper';
        },
        entryFileNames: (chunk) => {
          if (chunk.name === 'lab') return 'lab/main.js';
          if (chunk.name === 'play') return 'game/play-page.js';
          return 'app/main.js';
        },
        chunkFileNames: 'app/[name]-[hash].js',
        assetFileNames: 'app/[name]-[hash].js',
      },
    },
  },
});
