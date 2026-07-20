import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    // `npm run dev:app` proxies API calls to a running `wrangler dev`.
    proxy: {
      '/api': 'http://localhost:8787',
    },
  },
});
