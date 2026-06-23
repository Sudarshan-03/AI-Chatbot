import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Vite config — serves the React app on http://localhost:5173
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    open: true,
  },
});
