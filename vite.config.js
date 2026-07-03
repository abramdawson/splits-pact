import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const page = name => fileURLToPath(new URL(name, import.meta.url));

// Mounts the Express API (server.js) inside the Vite dev server so `npm run dev`
// is a single process. Unmatched requests fall through to Vite's middleware.
const pactApi = {
  name: 'pact-api',
  apply: 'serve',
  async configureServer(server) {
    const { createApp } = await import('./server.js');
    server.middlewares.use(createApp({ staticDir: null }));
  },
};

export default defineConfig({
  appType: 'mpa',
  plugins: [react(), pactApi],
  build: {
    rollupOptions: {
      input: {
        index: page('index.html'),
        create: page('create.html'),
        status: page('status.html'),
        buy: page('buy.html'),
      },
    },
  },
});
