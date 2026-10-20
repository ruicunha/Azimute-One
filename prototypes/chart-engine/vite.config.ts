import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/noaa-chart': {
        target: 'https://charts.noaa.gov',
        changeOrigin: true,
        secure: true,
        rewrite: () => '/ENCs/US5MA12M.zip',
      },
    },
  },
});
