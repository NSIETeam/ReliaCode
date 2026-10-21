import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import test from 'node:test';

function listen(server) {
  return new Promise((resolve, reject) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)).once('error', reject));
}

test('Web proxy ignores hostile Host data and restores security headers', async (t) => {
  let receivedHeaders;
  const upstream = createServer((request, response) => {
    receivedHeaders = request.headers;
    response.setHeader('X-Frame-Options', 'SAMEORIGIN');
    response.setHeader('Cache-Control', 'public, max-age=9999');
    response.writeHead(200, { 'Content-Type':'application/json' }).end('{}');
  });
  const upstreamPort = await listen(upstream);
  t.after(() => upstream.close());

  const probe = createServer();
  const webPort = await listen(probe);
  await new Promise((resolve) => probe.close(resolve));
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd:new URL('..', import.meta.url),
    env:{ ...process.env, NODE_ENV:'production', HOST:'127.0.0.1', PORT:String(webPort), RELIACODE_API_URL:`http://127.0.0.1:${upstreamPort}`, RELIACODE_PUBLIC_ORIGIN:'https://trace.example.cn', APP_VERSION:'sha-test', GIT_SHA:'test-revision' },
    stdio:['ignore', 'ignore', 'pipe']
  });
  t.after(() => child.kill('SIGTERM'));
  await Promise.race([once(child, 'spawn'), once(child, 'error').then(([error]) => Promise.reject(error))]);

  let response;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      response = await fetch(`http://127.0.0.1:${webPort}/api/v1/probe`, { headers:{ Host:'attacker.invalid', 'X-Forwarded-Host':'attacker.invalid', 'X-Forwarded-Proto':'http' } });
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  assert.ok(response, 'Web server did not start');
  assert.equal(response.status, 200);
  assert.equal(receivedHeaders['x-forwarded-host'], 'trace.example.cn');
  assert.equal(receivedHeaders['x-forwarded-proto'], 'https');
  assert.equal(receivedHeaders.host, `127.0.0.1:${upstreamPort}`);
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const health=await fetch(`http://127.0.0.1:${webPort}/health/live`).then(value=>value.json());
  assert.deepEqual(health,{status:'ok',service:'reliacode-web',version:'sha-test',revision:'test-revision'});
});

test('production Web refuses a missing, plaintext, or non-origin public URL', async () => {
  for (const publicOrigin of ['', 'http://trace.example.cn', 'https://trace.example.cn/login']) {
    const child = spawn(process.execPath, ['server.mjs'], {
      cwd:new URL('..', import.meta.url),
      env:{ ...process.env, NODE_ENV:'production', HOST:'127.0.0.1', PORT:'0', RELIACODE_PUBLIC_ORIGIN:publicOrigin },
      stdio:['ignore', 'ignore', 'pipe']
    });
    let stderr='';
    child.stderr.on('data',(chunk)=>{stderr+=chunk;});
    const [code]=await once(child,'exit');
    assert.notEqual(code,0);
    assert.match(stderr,/requires RELIACODE_PUBLIC_ORIGIN to be an exact HTTPS origin/);
  }
});
