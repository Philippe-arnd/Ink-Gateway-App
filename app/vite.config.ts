import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  base: process.env.VITE_BASE_PATH ?? '/',
  server: {
    fs: {
      // src/index.css imports ../../design/tokens.css — the design system is
      // shared with the landing site and lives at the repo root, outside this
      // project root. Production builds inline it; the dev server needs
      // explicit permission to read above the root.
      allow: ['..'],
    },
  },
})
