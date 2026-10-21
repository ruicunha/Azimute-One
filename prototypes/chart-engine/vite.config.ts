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
      '/noaa-inner-harbor': {
        target: 'https://charts.noaa.gov',
        changeOrigin: true,
        secure: true,
        rewrite: () => '/ENCs/US5MA11M.zip',
      },
      '/noaa-small-scale': {
        target: 'https://charts.noaa.gov',
        changeOrigin: true,
        secure: true,
        rewrite: () => '/ENCs/US1GC09M.zip',
      },
      '/noaa-ny-approaches': {
        target: 'https://charts.noaa.gov',
        changeOrigin: true,
        secure: true,
        rewrite: () => '/ENCs/US4NY13M.zip',
      },
      '/noaa-ny-harbor': {
        target: 'https://charts.noaa.gov',
        changeOrigin: true,
        secure: true,
        rewrite: () => '/ENCs/US5NY14M.zip',
      },
      '/chs-sample': {
        target: 'https://www.chs.gc.ca',
        changeOrigin: true,
        secure: true,
        rewrite: () => '/documents/charts-cartes/instruction-formation/9995_S57ENC.zip',
      },
    },
  },
});
