import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const apiPort = process.env.DASHBOARD_DEV_API_PORT || process.env.PORT || '8080';
const apiHost = process.env.DASHBOARD_DEV_API_HOST || '127.0.0.1';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': `http://${apiHost}:${apiPort}`
    }
  },
  build: {
    outDir: 'dist',
    sourcemap: true
  }
});
