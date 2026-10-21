import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = new URL('../', import.meta.url);
const read = path => readFileSync(new URL(path, root), 'utf8');

function sourceFiles(dir) {
  const absolute = new URL(dir, root);
  return readdirSync(absolute).flatMap(name => {
    const item = join(absolute.pathname, name);
    if (statSync(item).isDirectory()) return sourceFiles(relative(root.pathname, item) + '/');
    return /\.(?:ejs|js|svg|css)$/.test(name) ? [item] : [];
  });
}

test('codes template cannot terminate its main script from print HTML', () => {
  const source = read('views/codes.ejs');
  assert.equal((source.match(/<script>/g) || []).length, 1);
  assert.equal((source.match(/<\/script>/g) || []).length, 1);
  assert.match(source, /<script\\x3e/);
  assert.match(source, /<\\\/script>/);
  assert.match(source, /const siteBrand = <%\- JSON\.stringify/);
});

test('login page never persists a password in browser storage', () => {
  const source = read('views/login.ejs');
  assert.doesNotMatch(source, /localStorage|trace_saved_login|saved\.p|btoa\(/);
  assert.match(source, /autocomplete="current-password"/);
});

test('production networking and QR generation retain required safety invariants', () => {
  const source = read('server.js');
  assert.match(source, /secure: 'auto'/);
  assert.match(source, /const getBaseUrl = \(req\) => `\$\{req\.protocol\}:\/\/\$\{req\.get\('host'\)\}`/);
  assert.match(source, /generated\.push\(\{ id: Number\(boxResult\.lastInsertRowid\)/);
  assert.match(source, /generated\.push\(\{ id: Number\(itemResult\.lastInsertRowid\)/);
  assert.match(source, /app\.listen\(PORT, '127\.0\.0\.1'/);
  assert.doesNotMatch(source, /reqHostCache|trace-fallback-secret/);
});

test('brand staff cannot reach account, invitation, or destructive code routes', () => {
  const source = read('server.js');
  for (const route of [
    "app.get('/api/invitations'", "app.post('/api/invitations'",
    "app.delete('/api/invitations/:id'", "app.get('/users'",
    "app.get('/api/users'", "app.post('/api/users'",
    "app.delete('/api/codes/:type/:id'", "app.post('/api/codes/batch-delete'"
  ]) {
    const start = source.indexOf(route);
    assert.notEqual(start, -1, `missing route ${route}`);
    assert.doesNotMatch(source.slice(start, source.indexOf('\n', start)), /brand_staff/, route);
  }
});

test('factory deletion follows product ownership without querying missing code columns', () => {
  const server = read('server.js');
  assert.doesNotMatch(server, /FROM boxes WHERE factory_id=/);
  assert.doesNotMatch(server, /FROM items WHERE factory_id=/);
  assert.doesNotMatch(server, /UPDATE boxes SET factory_id=/);
  assert.doesNotMatch(server, /UPDATE items SET factory_id=/);
  assert.match(server, /FROM boxes b JOIN products p ON p\.id=b\.product_id WHERE p\.factory_id=/);
  assert.match(server, /FROM items i JOIN products p ON p\.id=i\.product_id WHERE p\.factory_id=/);
});

test('all account creation and password reset routes enforce the pilot password policy', () => {
  const server = read('server.js');
  assert.match(server, /PASSWORD_POLICY_MESSAGE = '密码至少12位/);
  assert.match(server, /password\.length >= 12/);
  assert.match(server, /\/\[A-Za-z\]\//);
  assert.match(server, /\/\\d\//);
  assert.doesNotMatch(server, /密码至少6位|新密码至少6位/);
});

test('active first-party runtime sources contain no emoji icons', () => {
  const files = [
    new URL('server.js', root).pathname,
    new URL('database.js', root).pathname,
    ...sourceFiles('views/'),
    new URL('public/js/scanner.js', root).pathname
  ];
  const emoji = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/u;
  const failures = files.filter(file => emoji.test(readFileSync(file, 'utf8')));
  assert.deepEqual(failures, []);
});

test('monochrome SVG sprite and responsive UI contracts exist', () => {
  const icons = read('public/icons/ui.svg');
  const css = read('public/css/style.css');
  assert.match(icons, /<symbol id="camera"/);
  assert.match(icons, /<symbol id="box"/);
  assert.match(css, /\.ui-icon/);
  assert.match(css, /@media \(max-width: 768px\)/);
  assert.match(css, /overflow-x:auto/);
});
