import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

// Renderer is a standard Vite React app rooted at src/renderer so it can run
// both inside Electron (loaded by electron/main.js) and standalone in a browser
// (for fast visual iteration / preview).
export default defineConfig({
  root: resolve(__dirname, 'src/renderer'),
  base: './',
  plugins: [react()],
  server: { port: Number(process.env.PORT) || 5173, strictPort: true },
  define: {
    // Which build am I running? — shown in Settings; ends the stale-install guessing game.
    __BUILD_TIME__: JSON.stringify(new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC'),
  },
  build: {
    outDir: resolve(__dirname, 'dist/renderer'),
    emptyOutDir: true,
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src/renderer/src'),
      '@shared': resolve(__dirname, 'src/shared'),
    },
  },
})
