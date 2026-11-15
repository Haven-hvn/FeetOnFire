import { defineConfig } from 'vite';

export default defineConfig({
  base: '/dist/',
  build: {
    target: 'es2022',
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: { main: 'src/app/main.ts' },
      output: {
        entryFileNames: 'app/main.js',
        chunkFileNames: 'app/[name]-[hash].js',
        assetFileNames: 'app/[name]-[hash].js',
      },
    },
  },
});
