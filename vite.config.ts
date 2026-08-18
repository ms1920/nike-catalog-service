import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'web',
  plugins: [react()],
  server: {
    port: 5173,
    // Proxying /api to the API server means the client never needs an absolute
    // origin, so there is no CORS config and no environment-specific base URL
    // baked into the bundle.
    proxy: {
      '/api': { target: 'http://localhost:3000', changeOrigin: true },
    },
  },
  build: {
    outDir: '../dist-web',
    emptyOutDir: true,
  },
});
