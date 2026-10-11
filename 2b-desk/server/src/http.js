// A deliberately small HTTP layer: routing, JSON bodies, CORS, security
// headers and static files. No framework, so there is little to update and
// nothing hidden.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { HttpError } from './errors.js';

export class Router {
  constructor() {
    this.routes = [];
  }
  add(method, pattern, handler, opts = {}) {
    const keys = [];
    const re = new RegExp(
      '^' +
        pattern.replace(/\//g, '\\/').replace(/:(\w+)/g, (_, k) => {
          keys.push(k);
          return '([^/]+)';
        }) +
        '$',
    );
    this.routes.push({ method, re, keys, handler, opts });
    return this;
  }
  match(method, pathname) {
    let allowed = false;
    for (const r of this.routes) {
      const m = r.re.exec(pathname);
      if (!m) continue;
      if (r.method !== method) {
        allowed = true;
        continue;
      }
      const params = {};
      r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
      return { route: r, params };
    }
    return allowed ? { methodNotAllowed: true } : null;
  }
}

export async function readJson(req, limit = 64 * 1024) {
  const type = String(req.headers['content-type'] || '');
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'That request is too large.');
    chunks.push(chunk);
  }
  if (!size) return {};
  if (!type.includes('json')) throw new HttpError(415, 'Send JSON (content-type: application/json).');
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    // n8n sometimes wraps a body in an array — accept the first item.
    if (Array.isArray(parsed)) return parsed[0] ?? {};
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    throw new HttpError(400, 'The request body is not valid JSON.');
  }
}

export function sendJson(res, status, data, headers = {}) {
  const body = JSON.stringify(data ?? {});
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(body);
}

export function securityHeaders(res) {
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'strict-origin-when-cross-origin');
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('permissions-policy', 'camera=(), microphone=(), geolocation=()');
}

export function applyCors(req, res, allowed) {
  const origin = req.headers.origin;
  if (!origin || !allowed.length) return false;
  if (!allowed.includes(origin.replace(/\/+$/, ''))) return false;
  res.setHeader('access-control-allow-origin', origin);
  res.setHeader('vary', 'Origin');
  res.setHeader('access-control-allow-headers', 'authorization, content-type, x-desk-secret');
  res.setHeader('access-control-allow-methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.setHeader('access-control-max-age', '600');
  return true;
}

export function clientIp(req, trustProxy) {
  if (trustProxy) {
    const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (fwd) return fwd;
  }
  return req.socket.remoteAddress || '';
}

// Login throttling: per IP + username and per IP, in memory.
export function createLimiter({ windowMs = 15 * 60_000, max = 10 } = {}) {
  const hits = new Map();
  return {
    hit(key) {
      const t = Date.now();
      const h = hits.get(key);
      if (!h || h.reset < t) {
        hits.set(key, { n: 1, reset: t + windowMs });
        return true;
      }
      h.n += 1;
      return h.n <= max;
    },
    clear(key) {
      hits.delete(key);
    },
    sweep() {
      const t = Date.now();
      for (const [k, h] of hits) if (h.reset < t) hits.delete(k);
    },
  };
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

export function createStatic(rootDir, { csp }) {
  const root = path.resolve(rootDir);
  return async function serve(req, res, pathname) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;
    let rel;
    try {
      rel = decodeURIComponent(pathname);
    } catch {
      return false;
    }
    if (rel.includes('\0')) return false;
    let file = path.resolve(root, '.' + path.posix.normalize('/' + rel));
    if (file !== root && !file.startsWith(root + path.sep)) return false;
    let stat;
    try {
      stat = await fsp.stat(file);
      if (stat.isDirectory()) {
        file = path.join(file, 'index.html');
        stat = await fsp.stat(file);
      }
    } catch {
      // Unknown paths without a file extension get the app (client routing).
      if (path.extname(rel)) return false;
      file = path.join(root, 'index.html');
      try {
        stat = await fsp.stat(file);
      } catch {
        return false;
      }
    }
    const ext = path.extname(file).toLowerCase();
    const etag = `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
    res.setHeader('etag', etag);
    // Always revalidate: deploys show up immediately, unchanged files cost a 304.
    res.setHeader('cache-control', 'no-cache');
    if (ext === '.html') res.setHeader('content-security-policy', csp(req));
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304);
      res.end();
      return true;
    }
    res.writeHead(200, {
      'content-type': MIME[ext] || 'application/octet-stream',
      'content-length': stat.size,
    });
    if (req.method === 'HEAD') {
      res.end();
      return true;
    }
    fs.createReadStream(file).pipe(res);
    return true;
  };
}
