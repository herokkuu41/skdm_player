import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  makePreviewUrl,
  normalizeTitle,
  openVideoConfig,
  parseDriveFileId,
  safeSecretEqual,
  sealVideoConfig
} from './lib/core.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const PORT = Number(process.env.PORT || 10000);
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const SIGNING_SECRET = process.env.SIGNING_SECRET || '';
const NODE_ENV = process.env.NODE_ENV || 'production';

if (!ADMIN_PASSWORD) {
  console.error('Missing ADMIN_PASSWORD environment variable.');
  process.exit(1);
}
if (SIGNING_SECRET.length < 32) {
  console.error('SIGNING_SECRET must be at least 32 characters long.');
  process.exit(1);
}

const files = new Map();
for (const [route, filename, contentType] of [
  ['/', 'index.html', 'text/html; charset=utf-8'],
  ['/watch', 'index.html', 'text/html; charset=utf-8'],
  ['/admin', 'admin.html', 'text/html; charset=utf-8'],
  ['/assets/styles.css', 'styles.css', 'text/css; charset=utf-8'],
  ['/assets/watch.js', 'watch.js', 'text/javascript; charset=utf-8'],
  ['/assets/admin.js', 'admin.js', 'text/javascript; charset=utf-8']
]) {
  files.set(route, { filename, contentType, body: null });
}

async function loadStaticFiles() {
  await Promise.all([...files.values()].map(async (item) => {
    item.body = await readFile(path.join(PUBLIC_DIR, item.filename));
  }));
}
await loadStaticFiles();

const attempts = new Map();
const RATE_WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILED_ATTEMPTS = 20;

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded) return forwarded.split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}

function isBlocked(ip, now = Date.now()) {
  const entry = attempts.get(ip);
  if (!entry) return false;
  if (now - entry.startedAt > RATE_WINDOW_MS) {
    attempts.delete(ip);
    return false;
  }
  return entry.failures >= MAX_FAILED_ATTEMPTS;
}

function recordFailure(ip, now = Date.now()) {
  const entry = attempts.get(ip);
  if (!entry || now - entry.startedAt > RATE_WINDOW_MS) {
    attempts.set(ip, { startedAt: now, failures: 1 });
    return;
  }
  entry.failures += 1;
}

function clearFailures(ip) {
  attempts.delete(ip);
}

function securityHeaders(contentType = '') {
  const headers = {
    'Content-Security-Policy': "default-src 'self'; frame-src https://drive.google.com https://docs.google.com https://*.googleusercontent.com; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; object-src 'none'; frame-ancestors 'none'",
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cache-Control': 'no-store'
  };
  if (contentType) headers['Content-Type'] = contentType;
  return headers;
}

function send(res, status, body = '', extraHeaders = {}) {
  res.writeHead(status, { ...securityHeaders(), ...extraHeaders });
  res.end(body);
}

function json(res, status, payload) {
  send(res, status, JSON.stringify(payload), { 'Content-Type': 'application/json; charset=utf-8' });
}

async function readJson(req, maxBytes = 16 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(Object.assign(new Error('Request too large.'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve(text ? JSON.parse(text) : {});
      } catch {
        reject(Object.assign(new Error('Invalid JSON.'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function publicOrigin(req) {
  const proto = String(req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
  const host = req.headers.host;
  return `${proto}://${host}`;
}

function sameOriginRequest(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  return origin === publicOrigin(req);
}

function getExpiryMs(value) {
  const days = Number(value || 0);
  if (days === 0) return 0;
  if (![1, 7, 30, 90].includes(days)) throw new Error('Invalid expiry setting.');
  return Date.now() + days * 24 * 60 * 60 * 1000;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    if (req.method === 'GET' && url.pathname === '/healthz') {
      return send(res, 200, 'ok', { 'Content-Type': 'text/plain; charset=utf-8' });
    }

    if (req.method === 'GET' && files.has(url.pathname)) {
      const file = files.get(url.pathname);
      return send(res, 200, file.body, {
        'Content-Type': file.contentType,
        'Cache-Control': file.contentType.startsWith('text/html') ? 'no-store' : 'public, max-age=3600'
      });
    }

    if (req.method === 'POST' && url.pathname === '/api/create') {
      if (!sameOriginRequest(req)) return json(res, 403, { error: 'Cross-origin request blocked.' });
      const ip = getClientIp(req);
      if (isBlocked(ip)) return json(res, 429, { error: 'Too many failed admin attempts. Try again later.' });

      const suppliedPassword = req.headers['x-admin-password'];
      if (!safeSecretEqual(suppliedPassword, ADMIN_PASSWORD)) {
        recordFailure(ip);
        return json(res, 401, { error: 'Incorrect admin password.' });
      }
      clearFailures(ip);

      const body = await readJson(req);
      const fileId = parseDriveFileId(body.driveUrl);
      const title = normalizeTitle(body.title);
      const expiresAt = getExpiryMs(body.expiryDays);
      const token = sealVideoConfig({ fileId, title, expiresAt }, SIGNING_SECRET);
      const watchUrl = `${publicOrigin(req)}/watch?v=${encodeURIComponent(token)}`;
      return json(res, 201, { watchUrl, title, expiresAt: expiresAt || null });
    }

    if (req.method === 'GET' && url.pathname === '/api/video') {
      const token = url.searchParams.get('v');
      if (!token || token.length > 8192) return json(res, 400, { error: 'Missing or invalid watch token.' });

      try {
        const video = openVideoConfig(token, SIGNING_SECRET);
        return json(res, 200, {
          title: video.title,
          previewUrl: makePreviewUrl(video.fileId),
          expiresAt: video.expiresAt ? video.expiresAt * 1000 : null
        });
      } catch (err) {
        const status = err?.code === 'EXPIRED' ? 410 : 400;
        return json(res, status, { error: err.message });
      }
    }

    if (req.method === 'HEAD') return send(res, 404);
    return json(res, 404, { error: 'Not found.' });
  } catch (err) {
    if (NODE_ENV !== 'production') console.error(err);
    return json(res, err?.status || 500, { error: err?.status ? err.message : 'Server error.' });
  }
});

server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;
server.requestTimeout = 15_000;

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Private stream control app listening on port ${PORT}`);
});
