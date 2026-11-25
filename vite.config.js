import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import {
  collectLocalServerInfo,
  createLanSyncHandler,
} from './src/server/lanSyncMiddleware.js';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

function lanSyncPlugin() {
  let activePort = 5173;
  const handler = createLanSyncHandler({
    rootDir: process.cwd(),
    getPort: () => activePort,
    appMeta: pkg,
  });

  const attachMiddleware = (server, fallbackPort) => {
    activePort = fallbackPort;
    server.httpServer?.once('listening', () => {
      const addr = server.httpServer?.address();
      if (addr && typeof addr === 'object' && addr.port) {
        activePort = addr.port;
      }
    });
    server.middlewares.use((req, res, next) => {
      handler(req, res, next).catch((err) => next(err));
    });
  };

  return {
    name: 'pingpong-lan-sync',
    configureServer(server) {
      attachMiddleware(server, server.config.server?.port || 5173);
      // Automatically restart Vite dev server when backend sync/RBAC modules change
      const onBackendChange = (file) => {
        const normalized = String(file || '').replace(/\\/g, '/');
        if (
          normalized.endsWith('/src/server/lanSyncMiddleware.js') ||
          normalized.endsWith('/src/engine/roles.js') ||
          normalized.endsWith('/src/engine/tournamentId.js') ||
          normalized.endsWith('/src/engine/lanAddress.js')
        ) {
          server.restart();
        }
      };
      server.watcher.on('change', onBackendChange);
    },
    configurePreviewServer(server) {
      attachMiddleware(server, server.config.preview?.port || 4173);
    },
  };
}

export default defineConfig({
  plugins: [react(), lanSyncPlugin()],
  define: {
    __BUILD_SERVER_INFO__: JSON.stringify(collectLocalServerInfo(5173, pkg)),
  },
  server: {
    port: 5173,
    host: true,
  },
  preview: {
    port: 4173,
    host: true,
  },
});
