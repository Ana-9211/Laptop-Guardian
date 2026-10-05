import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const bridge = process.env.GUARDIAN_BRIDGE || 'http://127.0.0.1:7878';
export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist', sourcemap: false, chunkSizeWarningLimit: 700 },
  server: {
    host: '127.0.0.1',
    proxy: {
      '/api': {
        target: bridge,
        changeOrigin: true,
        // The bridge only accepts its own origin on mutations; rewrite for dev.
        headers: { origin: bridge },
      },
    },
  },
});
