import { defineConfig } from 'vite';
import { resolve } from 'path';
import { fileURLToPath } from 'url';

// Use repo name as base on GitHub Pages, otherwise '/'
const repoName = process.env.GITHUB_REPOSITORY?.split('/')?.[1];
const base = repoName ? `/${repoName}/` : '/';

export default defineConfig({
  base,
  build: {
    rollupOptions: {
      input: {
        index: resolve(fileURLToPath(new URL('.', import.meta.url)), 'index.html'),
        v1: resolve(fileURLToPath(new URL('./', import.meta.url)), 'v1/index.html'),
        v2: resolve(fileURLToPath(new URL('./', import.meta.url)), 'v2/index.html'),
      },
    },
  },
});

