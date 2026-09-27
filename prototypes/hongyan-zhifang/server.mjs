import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const port = Number(process.env.PORT || 4178);
const upstream = '47.116.30.60';
const mime = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.webp': 'image/webp'
};

function proxy(request, response) {
  const headers = { ...request.headers, host: upstream };
  delete headers.origin;
  const proxyRequest = https.request({
    hostname: upstream,
    port: 443,
    path: request.url,
    method: request.method,
    headers,
    rejectUnauthorized: false
  }, upstreamResponse => {
    const outgoing = { ...upstreamResponse.headers };
    delete outgoing['content-security-policy'];
    response.writeHead(upstreamResponse.statusCode || 502, outgoing);
    upstreamResponse.pipe(response);
  });
  proxyRequest.on('error', error => {
    response.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ message: `本地预览代理连接失败：${error.message}` }));
  });
  request.pipe(proxyRequest);
}

function sendFile(response, filePath) {
  fs.stat(filePath, (error, stat) => {
    if (error || !stat.isFile()) {
      sendFile(response, path.join(root, 'index.html'));
      return;
    }
    response.writeHead(200, {
      'content-type': mime[path.extname(filePath)] || 'application/octet-stream',
      'cache-control': 'no-store'
    });
    fs.createReadStream(filePath).pipe(response);
  });
}

http.createServer((request, response) => {
  if (request.url?.startsWith('/api/')) {
    proxy(request, response);
    return;
  }
  const pathname = decodeURIComponent(new URL(request.url || '/', `http://${request.headers.host}`).pathname);
  const candidate = path.resolve(root, `.${pathname}`);
  if (!candidate.startsWith(root + path.sep) && candidate !== root) {
    response.writeHead(403).end('Forbidden');
    return;
  }
  sendFile(response, candidate === root ? path.join(root, 'index.html') : candidate);
}).listen(port, '127.0.0.1', () => {
  console.log(`鸿雁知访本地主题预览：http://127.0.0.1:${port}/login`);
});
