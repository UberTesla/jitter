/**
 * Standalone Zero-Dependency Production Server for Ping Pong Championship Scoreboard.
 * Run `npm run build && npm start` on ANY device with Node.js (laptop, desktop,
 * Raspberry Pi, or Android Termux) to serve the app and real-time LAN Sync Hub.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  collectLocalServerInfo,
  createLanSyncHandler,
} from './src/server/lanSyncMiddleware.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(__dirname, 'dist');
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
const PORT = Number(process.env.PORT) || 5173;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

const syncHandler = createLanSyncHandler({
  rootDir: process.env.DATA_DIR || __dirname,
  getPort: () => PORT,
  appMeta: pkg,
});

const server = http.createServer((req, res) => {
  syncHandler(req, res, () => {
    const urlPath = new URL(req.url || '/', 'http://localhost').pathname;
    const safePath = path.normalize(urlPath).replace(/^(\.\.[/\\])+/, '');
    let filePath = path.join(distDir, safePath === '/' ? 'index.html' : safePath);

    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      // SPA fallback for /control, /score, /present, /debug
      filePath = path.join(distDir, 'index.html');
    }

    if (!fs.existsSync(filePath)) {
      res.statusCode = 404;
      res.end('Build not found. Run `npm run build` first.');
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    res.setHeader('Content-Type', MIME_TYPES[ext] || 'application/octet-stream');
    if (safePath === '/sw.js' || safePath === '/manifest.json' || ext === '.html') {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    } else if (safePath.startsWith('/assets/')) {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    }
    fs.createReadStream(filePath).pipe(res);
  }).catch((err) => {
    res.statusCode = 500;
    res.end(err?.message || 'Internal server error');
  });
});

server.listen(PORT, '0.0.0.0', () => {
  const info = collectLocalServerInfo(PORT, pkg);
  console.log(`\n🏓 Ping Pong Championship Server running on port ${PORT}`);
  console.log(`   Local:   http://localhost:${PORT}`);
  for (const lan of info.lanAddresses) {
    console.log(`   Network: http://${lan.address}:${PORT}  (${lan.interfaceName})`);
  }
  if (process.env.ADMIN_KEY?.trim()) {
    console.log('   Admin:     ADMIN_KEY environment variable enabled');
  }
  if (typeof syncHandler.getAdminKey === 'function') {
    console.log(`   Admin Key: ${syncHandler.getAdminKey()}`);
  }
  console.log('');
});
