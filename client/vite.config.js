import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    fs: { allow: ['..'] }, // the demo reads the shared demo data and pictures from ../server
    port: 5173,
    proxy: { '/api': 'http://localhost:5000' },
  },
});
