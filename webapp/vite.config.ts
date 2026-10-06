import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import {defineConfig} from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 3000,
    // В проде FastAPI сам отдаёт и статику, и /api (same-origin); в dev проксируем на него.
    proxy: {'/api': 'http://localhost:8000'},
  },
});
