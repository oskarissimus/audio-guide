import { defineConfig } from 'vite';

// Use repo name as base on GitHub Pages, otherwise '/'
const repoName = process.env.GITHUB_REPOSITORY?.split('/')?.[1];
const base = repoName ? `/${repoName}/` : '/';

export default defineConfig({
  base,
});

