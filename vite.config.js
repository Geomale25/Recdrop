import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: './',
  server: { port: 5173, strictPort: true, host: '127.0.0.1' },
  // assetsInlineLimit 0: keep the audio worklet as a real file (CSP blocks data: scripts).
  build: { outDir: 'dist', emptyOutDir: true, assetsInlineLimit: 0 },
});
