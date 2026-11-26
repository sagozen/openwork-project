import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Cổng cố định cho PoC: web 5174, API 8765.
export default defineConfig({
  plugins: [react()],
  preview: { port: 5175, strictPort: true },
  server: {
    port: 5174,
    strictPort: true,
    proxy: {
      '/api': 'http://127.0.0.1:8765',
      '/ws': { target: 'ws://127.0.0.1:8765', ws: true },
    },
  },
})
