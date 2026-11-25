import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // Local API server (server/index.ts) handles outside data calls and caching.
    proxy: { '/api': 'http://localhost:8787' },
  },
})
