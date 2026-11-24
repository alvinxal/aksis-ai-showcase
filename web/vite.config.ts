import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// /v1 is the public JSON API of the backend (npm run dev in the repo root, port 18881).
// /api, /setup and /internal are operator-only and are deliberately not proxied.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    // changeOrigin stays off: the backend compares the Origin of a write with the Host it receives.
    // /join/<token> is a page of the app; only its POST (/v1/join) goes to the backend.
    proxy: { '/v1': { target: 'http://127.0.0.1:18881', changeOrigin: false } },
  },
})
