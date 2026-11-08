import { defineConfig } from 'vite';
// base './' supports local dev, hosted subpaths, and GitHub Pages.
export default defineConfig({ base: './', build: { target: 'es2022', outDir: 'dist' } });
