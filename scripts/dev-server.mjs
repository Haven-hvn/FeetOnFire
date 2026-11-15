// Local static file server for development.
//
// - Binds to 127.0.0.1 only. There is deliberately no option to widen the bind.
// - Sets the cross-origin isolation headers (COOP/COEP) that SharedArrayBuffer and
//   fine-grained timers need.
// - Serves only the directories listed in SERVED; the StepMania reference tree and
//   everything else in the project root are not reachable.
// - Rejects requests whose Host header is not this loopback listener (DNS rebinding).

import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const SERVED = ['app', 'lab', 'dist', 'src'];
const HOST = '127.0.0.1';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.ts': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const HEADERS = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'X-Content-Type-Options': 'nosniff',
  'Cache-Control': 'no-store',
};

function send(res, status, body, extra = {}) {
  res.writeHead(status, { ...HEADERS, 'Content-Type': 'text/plain; charset=utf-8', ...extra });
  res.end(body);
}

async function handle(req, res) {
  const port = req.socket.localPort;
  const host = req.headers.host ?? '';
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
    return send(res, 403, 'Forbidden host');
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return send(res, 405, 'Method not allowed', { Allow: 'GET, HEAD' });
  }

  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://127.0.0.1').pathname);
  } catch {
    return send(res, 400, 'Bad request');
  }
  if (pathname === '/') {
    return send(res, 302, '', { Location: '/app/' });
  }
  if (pathname.includes('\0')) return send(res, 400, 'Bad request');

  const top = pathname.split('/')[1];
  if (!SERVED.includes(top)) return send(res, 404, 'Not found');

  let file = resolve(ROOT, '.' + pathname);
  if (file !== ROOT && !file.startsWith(ROOT + sep)) return send(res, 403, 'Forbidden');

  let info;
  try {
    info = await stat(file);
    if (info.isDirectory()) {
      if (!pathname.endsWith('/')) return send(res, 302, '', { Location: pathname + '/' });
      file = resolve(file, 'index.html');
      info = await stat(file);
    }
  } catch {
    return send(res, 404, 'Not found');
  }
  if (!info.isFile()) return send(res, 404, 'Not found');

  const type = MIME[extname(file)] ?? 'application/octet-stream';
  res.writeHead(200, { ...HEADERS, 'Content-Type': type, 'Content-Length': info.size });
  if (req.method === 'HEAD') return res.end();
  createReadStream(file).on('error', () => res.destroy()).pipe(res);
}

export function createLabServer() {
  return createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) send(res, 500, 'Server error');
      else res.destroy();
    });
  });
}

/** Start listening on the loopback interface. Port 0 picks a free port. */
export function listen(server, port) {
  return new Promise((ok, fail) => {
    server.once('error', fail);
    server.listen(port, HOST, () => ok(server.address().port));
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const wanted = Number(process.env.PORT ?? 5173);
  const port = await listen(createLabServer(), Number.isInteger(wanted) ? wanted : 5173);
  console.log(`Game: http://localhost:${port}/app/   Latency Lab: http://localhost:${port}/lab/   (loopback only)`);
}
