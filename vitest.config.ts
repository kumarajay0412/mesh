import { defineConfig } from 'vitest/config'

// Separate from vite.config.ts on purpose: the app's Vite root is the
// renderer, while unit tests live in the main process tree.
export default defineConfig({
  test: {
    include: ['src/main/**/*.test.ts'],
    environment: 'node',
  },
})
