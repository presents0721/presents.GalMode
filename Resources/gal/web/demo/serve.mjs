/**
 * 演示用静态服务器：托管 demo/ 与 src/，并把 story/ 目录打包成 /api/story。
 * 只需要 node，没有任何依赖。
 */

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadStoryFromDirectory, validateStory } from '../src/index.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const port = Number(process.env.PORT ?? 8787);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.yaml': 'text/yaml; charset=utf-8',
  '.yml': 'text/yaml; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');

    if (url.pathname === '/api/story') {
      const story = await loadStoryFromDirectory(join(root, 'story'));
      const report = validateStory(story);
      return send(res, 200, 'application/json; charset=utf-8', JSON.stringify({ story, report }));
    }

    if (url.pathname === '/') {
      res.writeHead(302, { Location: '/demo/' });
      return res.end();
    }

    let pathname = decodeURIComponent(url.pathname);

    if (pathname.endsWith('/')) pathname += 'index.html';

    const target = normalize(join(root, pathname));

    if (!target.startsWith(root)) {
      return send(res, 403, 'text/plain; charset=utf-8', 'forbidden');
    }

    const info = await stat(target).catch(() => null);

    if (!info?.isFile()) {
      return send(res, 404, 'text/plain; charset=utf-8', 'not found');
    }

    const body = await readFile(target);
    return send(res, 200, MIME[extname(target).toLowerCase()] ?? 'application/octet-stream', body);
  } catch (error) {
    return send(res, 500, 'text/plain; charset=utf-8', String(error?.stack ?? error));
  }
});

function send(res, status, type, body) {
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

server.listen(port, '127.0.0.1', () => {
  console.log(`GAL 剧本演示: http://127.0.0.1:${port}/demo/`);
});
