const express = require('express');
const readOnlyAccess = require('./readonly-access.cjs');
const session = require('express-session');
const SQLiteSessionStore = require('./sqlite-session-store');
const path = require('path');
const fs = require('fs');
const QRCode = require('qrcode');
const ExcelJS = require('exceljs');
const multer = require('multer');
const crypto = require('crypto');
const sharp = require('sharp');
const { db, initDatabase, hashPassword, verifyPassword } = require('./database');
const { CHINA_REGIONS, normalizeRegionSelection } = require('./region-catalog');

const app = express();
const PORT = process.env.PORT || 3000;
const IMAGE_ARCHIVE_MAX_CODES = Math.min(2000, Math.max(1, Number(process.env.IMAGE_ARCHIVE_MAX_CODES) || 500));
const IMAGE_ARCHIVE_MAX_CONCURRENT = Math.min(2, Math.max(1, Number(process.env.IMAGE_ARCHIVE_MAX_CONCURRENT) || 1));
let httpServer;
let shutdownStarted = false;
let imageArchiveJobs = 0;

// 初始化数据库
initDatabase();
const receiptIntegrity = require('./receipt-integrity.cjs')(db);

// 中间件
app.set('trust proxy', 1); // Nginx 反代：仅用于限流和不可逆来源标识。
app.disable('x-powered-by');
app.use(express.urlencoded({ extended: true, limit: '256kb' }));
app.use(express.json({ limit: '256kb' }));
app.use((req, res, next) => {
  const forwardedRequestId = String(req.get('x-request-id') || '');
  const requestId = /^(?:[a-f0-9]{32}|[a-f0-9-]{36})$/i.test(forwardedRequestId)
    ? forwardedRequestId
    : crypto.randomUUID();
  const cspNonce = crypto.randomBytes(18).toString('base64');
  req.requestId = requestId;
  res.locals.requestId = requestId;
  res.locals.cspNonce = cspNonce;
  res.setHeader('X-Request-ID', requestId);
  res.setHeader('Content-Security-Policy', `default-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; object-src 'none'; script-src 'self' 'nonce-${cspNonce}'; script-src-attr 'none'; style-src 'self' 'nonce-${cspNonce}'; style-src-attr 'none'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(self), geolocation=(), microphone=()');
  next();
});

const allowedHosts = new Set(
  String(process.env.ALLOWED_HOSTS || '8.140.52.117,127.0.0.1,localhost')
    .split(',').map(value => value.trim().toLowerCase()).filter(Boolean)
);
const normalizedRequestHost = req => {
  try { return new URL(`http://${String(req.get('host') || '')}`).hostname.toLowerCase(); }
  catch { return ''; }
};
app.use((req, res, next) => {
  const hostname = normalizedRequestHost(req);
  if (hostname && allowedHosts.has(hostname)) return next();
  res.status(421).json({ success: false, code: 'UNRECOGNIZED_HOST', msg: '请求主机未获授权', requestId: req.requestId });
});

// Supervisor/load-balancer probes stay public, cheap and session-free.
app.get('/healthz', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ status: 'ok' });
});

app.get('/readyz', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    db.prepare('SELECT 1 AS ready').get();
    res.json({ status: 'ready' });
  } catch (error) {
    console.error(JSON.stringify({ level: 'error', event: 'readiness_failed', requestId: req.requestId, message: error.message }));
    res.status(503).json({ status: 'unavailable', requestId: req.requestId });
  }
});

app.use(express.static(path.join(__dirname, 'public'), {
  etag: true,
  lastModified: true,
  maxAge: '1h',
  fallthrough: true,
  setHeaders: res => res.setHeader('Cache-Control', 'public, max-age=3600, must-revalidate')
}));

// ===================== 登录会话 =====================
const SESSION_SECRET = db.prepare("SELECT value FROM settings WHERE key='session_secret'").get()?.value;
if (!SESSION_SECRET || SESSION_SECRET.length < 32) throw new Error('session_secret is missing or too short');
const sessionStore = new SQLiteSessionStore(db, { defaultTtlMs: 12 * 60 * 60 * 1000 });
sessionStore.on('error', error => console.error('[SESSION] SQLite store error:', error));
app.use(session({
  name: process.env.NODE_ENV === 'production' ? '__Host-reliacode.sid' : 'reliacode.sid',
  secret: SESSION_SECRET,
  store: sessionStore,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: 'auto',
    sameSite: 'lax',
    maxAge: 12 * 60 * 60 * 1000 // 12小时免登录
  }
}));

// Refresh role/tenant scope from authoritative records, never the cached cookie snapshot.
app.use((req, res, next) => {
  if (!req.session.user) return next();
  const row = db.prepare(`SELECT u.id,u.username,u.display_name,u.role,u.enabled,u.brand_id,u.factory_id,u.distributor_id,
    b.enabled AS brand_enabled,b.name AS brand_name,f.enabled AS factory_enabled
    FROM users u LEFT JOIN brands b ON b.id=u.brand_id LEFT JOIN factories f ON f.id=u.factory_id WHERE u.id=?`).get(req.session.user.id);
  if (!row || !row.enabled || (row.brand_id && !row.brand_enabled) || (row.role === 'factory' && !row.factory_enabled)) {
    return req.session.destroy(() => res.status(401).json({success:false,needLogin:true,msg:'登录状态已失效'}));
  }
  req.session.user = {...req.session.user,id:row.id,username:row.username,display_name:row.display_name,
    role:row.role,brand_id:row.brand_id,factory_id:row.factory_id,distributor_id:row.distributor_id,brand_name:row.brand_name};
  if (row.role === readOnlyAccess.ROLE && !readOnlyAccess.allowed(req.method,req.path)) {
    return res.status(403).json({success:false,code:'READ_ONLY_ACCOUNT',msg:'当前账号仅供只读体验，请使用独立管理员账号执行操作。'});
  }
  next();
});

const CSRF_EXEMPT_PATHS = new Set(['/login', '/api/register/check-code', '/api/register', '/api/agent/login']);
app.use((req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method) || CSRF_EXEMPT_PATHS.has(req.path)) return next();
  // Bearer credentials are attached explicitly by an Agent and are not sent
  // automatically by a browser, so these requests do not need cookie-CSRF protection.
  if (req.path.startsWith('/api/agent/') && /^Bearer\s+rca_[A-Za-z0-9_-]{43}$/.test(String(req.get('authorization') || ''))) return next();
  const expectedOrigin = `${req.protocol}://${req.get('host')}`;
  const origin = req.get('origin');
  const fetchSite = req.get('sec-fetch-site');
  const agentHeader = req.get('x-reliacode-request');
  const browserSameOrigin = origin === expectedOrigin && (!fetchSite || fetchSite === 'same-origin');
  const explicitSameOriginClient = agentHeader === 'same-origin' && (!origin || origin === expectedOrigin);
  if (browserSameOrigin || explicitSameOriginClient) return next();
  return res.status(403).json({ success: false, code: 'CSRF_REJECTED', msg: '请求来源校验失败' });
});

const LOGIN_WINDOW_MS = 5 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 10;
db.exec(`
  CREATE TABLE IF NOT EXISTS login_rate_limits (
    source_hash TEXT PRIMARY KEY,
    attempt_count INTEGER NOT NULL,
    reset_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_login_rate_limits_reset_at ON login_rate_limits(reset_at);
`);
const readLoginLimit = db.prepare('SELECT attempt_count, reset_at FROM login_rate_limits WHERE source_hash=?');
const writeLoginLimit = db.prepare(`
  INSERT INTO login_rate_limits (source_hash, attempt_count, reset_at, updated_at) VALUES (?, ?, ?, ?)
  ON CONFLICT(source_hash) DO UPDATE SET attempt_count=excluded.attempt_count, reset_at=excluded.reset_at, updated_at=excluded.updated_at
`);
const deleteLoginLimit = db.prepare('DELETE FROM login_rate_limits WHERE source_hash=?');
const cleanupLoginLimits = db.prepare('DELETE FROM login_rate_limits WHERE reset_at<=?');
const loginSourceHash = req => crypto.createHmac('sha256', SESSION_SECRET)
  .update(`ip:${String(req.ip || req.socket.remoteAddress || 'unknown')}`)
  .digest('hex');
const loginAccountHash = req => crypto.createHmac('sha256', SESSION_SECRET)
  .update(`account:${String(req.body?.username || '').trim().toLowerCase() || 'unknown'}`)
  .digest('hex');
const recordLoginAttempt = db.transaction((sourceHash, now) => {
  cleanupLoginLimits.run(now);
  const current = readLoginLimit.get(sourceHash);
  const attemptCount = current && current.reset_at > now ? current.attempt_count + 1 : 1;
  const resetAt = current && current.reset_at > now ? current.reset_at : now + LOGIN_WINDOW_MS;
  writeLoginLimit.run(sourceHash, attemptCount, resetAt, now);
  return { attemptCount, resetAt };
});
function loginRateLimit(req, res, next) {
  const now = Date.now();
  const entries = [loginSourceHash(req), loginAccountHash(req)].map(key => recordLoginAttempt(key, now));
  const limited = entries.find(entry => entry.attemptCount > LOGIN_MAX_ATTEMPTS);
  if (limited) {
    res.setHeader('Retry-After', String(Math.max(1, Math.ceil((limited.resetAt - now) / 1000))));
    return res.status(429).render('login', { brand: '穿山甲溯源大师', error: '登录尝试过多，请稍后再试' });
  }
  next();
}
const registrationSourceHash = req => crypto.createHmac('sha256', SESSION_SECRET)
  .update(`register:${String(req.ip || req.socket.remoteAddress || 'unknown')}`)
  .digest('hex');
function registrationRateLimit(req, res, next) {
  const now = Date.now();
  const limit = recordLoginAttempt(registrationSourceHash(req), now);
  if (limit.attemptCount > 30) {
    res.setHeader('Retry-After', String(Math.max(1, Math.ceil((limit.resetAt - now) / 1000))));
    return res.status(429).json({ success: false, code: 'REGISTER_RATE_LIMITED', msg: '注册请求过于频繁，请稍后再试' });
  }
  next();
}

// ===================== Agent API authentication =====================
const AGENT_TOKEN_TTL_MS = 60 * 60 * 1000;
const AGENT_IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
db.exec(`
  CREATE TABLE IF NOT EXISTS agent_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    token_hash TEXT UNIQUE NOT NULL,
    client_name TEXT NOT NULL DEFAULT 'agent',
    scope TEXT NOT NULL DEFAULT 'codes:generate',
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    last_used_at INTEGER,
    revoked_at INTEGER,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
  CREATE INDEX IF NOT EXISTS idx_agent_tokens_user ON agent_tokens(user_id, expires_at);
  CREATE TABLE IF NOT EXISTS agent_idempotency (
    user_id INTEGER NOT NULL,
    route TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    response_json TEXT,
    status_code INTEGER,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, route, idempotency_key),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
  CREATE INDEX IF NOT EXISTS idx_agent_idempotency_expiry ON agent_idempotency(expires_at);
`);
const agentTokenHash = token => crypto.createHmac('sha256', SESSION_SECRET).update(`agent-token:${token}`).digest('hex');
const agentRequestHash = req => crypto.createHash('sha256')
  .update(`${req.path}\n${JSON.stringify(req.body || {})}`).digest('hex');
const readAgentToken = db.prepare(`
  SELECT t.id AS token_id, t.user_id, t.scope, t.expires_at,
    u.username, u.display_name, u.role, u.distributor_id, u.factory_id, u.brand_id, u.enabled,
    b.name AS brand_name, b.enabled AS brand_enabled
  FROM agent_tokens t
  JOIN users u ON u.id=t.user_id
  LEFT JOIN brands b ON b.id=u.brand_id
  WHERE t.token_hash=? AND t.revoked_at IS NULL AND t.expires_at>?
`);
const touchAgentToken = db.prepare('UPDATE agent_tokens SET last_used_at=? WHERE id=?');
function requireAgentToken(req, res, next) {
  const match = String(req.get('authorization') || '').match(/^Bearer\s+(rca_[A-Za-z0-9_-]{43})$/);
  if (!match) return res.status(401).json({ success: false, code: 'AGENT_AUTH_REQUIRED', msg: '需要 Agent Bearer 令牌', requestId: req.requestId });
  const now = Date.now();
  const record = readAgentToken.get(agentTokenHash(match[1]), now);
  if (!record || !record.enabled || (record.brand_id && !record.brand_enabled)) {
    return res.status(401).json({ success: false, code: 'AGENT_TOKEN_INVALID', msg: 'Agent 令牌无效、已过期或账号已停用', requestId: req.requestId });
  }
  if (record.role === readOnlyAccess.ROLE) return res.status(403).json({success:false,code:'READ_ONLY_ACCOUNT',msg:'只读体验账号不能使用 Agent 令牌'});
  req.agentTokenId = record.token_id;
  req.agentUser = {
    id: record.user_id,
    username: record.username,
    display_name: record.display_name || record.username,
    role: record.role,
    distributor_id: record.distributor_id || null,
    factory_id: record.factory_id || null,
    brand_id: record.brand_id || null,
    brand_name: record.brand_name || null
  };
  touchAgentToken.run(now, record.token_id);
  next();
}
function requireAgentRole(...roles) {
  return (req, res, next) => {
    if (!req.agentUser) return res.status(401).json({ success: false, code: 'AGENT_AUTH_REQUIRED', msg: '需要 Agent Bearer 令牌', requestId: req.requestId });
    if (!roles.includes(req.agentUser.role)) return res.status(403).json({ success: false, code: 'AGENT_ROLE_FORBIDDEN', msg: '该账号没有生码权限', requestId: req.requestId });
    next();
  };
}
function requireAgentIdempotency(req, res, next) {
  const key = String(req.get('idempotency-key') || '').trim();
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(key)) {
    return res.status(400).json({ success: false, code: 'IDEMPOTENCY_KEY_REQUIRED', msg: '需要 8-128 位 Idempotency-Key', requestId: req.requestId });
  }
  const now = Date.now();
  db.prepare('DELETE FROM agent_idempotency WHERE expires_at<=?').run(now);
  const route = req.path;
  const requestHash = agentRequestHash(req);
  const read = db.prepare('SELECT request_hash, response_json, status_code FROM agent_idempotency WHERE user_id=? AND route=? AND idempotency_key=?');
  const existing = read.get(req.agentUser.id, route, key);
  if (existing) {
    if (existing.request_hash !== requestHash) return res.status(409).json({ success: false, code: 'IDEMPOTENCY_CONFLICT', msg: '同一幂等键不能用于不同请求', requestId: req.requestId });
    if (existing.response_json) {
      res.setHeader('Idempotency-Replayed', 'true');
      return res.status(existing.status_code || 200).json(JSON.parse(existing.response_json));
    }
    return res.status(409).json({ success: false, code: 'IDEMPOTENCY_IN_PROGRESS', msg: '相同请求正在处理中', requestId: req.requestId });
  }
  db.prepare(`INSERT INTO agent_idempotency (user_id, route, idempotency_key, request_hash, created_at, expires_at)
    VALUES (?,?,?,?,?,?)`).run(req.agentUser.id, route, key, requestHash, now, now + AGENT_IDEMPOTENCY_TTL_MS);
  const originalJson = res.json.bind(res);
  let persisted = false;
  res.json = body => {
    const statusCode = res.statusCode || 200;
    db.prepare(`UPDATE agent_idempotency SET response_json=?, status_code=?
      WHERE user_id=? AND route=? AND idempotency_key=?`).run(JSON.stringify(body), statusCode, req.agentUser.id, route, key);
    persisted = true;
    return originalJson(body);
  };
  res.on('finish', () => {
    if (!persisted) db.prepare('DELETE FROM agent_idempotency WHERE user_id=? AND route=? AND idempotency_key=?').run(req.agentUser.id, route, key);
  });
  next();
}

// 浏览器端即时生码同样必须可安全重试。复用持久化幂等表，避免慢网、双击或
// 响应丢失后再次提交时分配第二批码。与 Agent 路由按 path 隔离。
function requireBrowserIdempotency(req, res, next) {
  const key = String(req.get('idempotency-key') || '').trim();
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(key)) {
    return res.status(400).json({ success: false, code: 'IDEMPOTENCY_KEY_REQUIRED', msg: '此操作需要有效的请求标识，请刷新页面后重试', requestId: req.requestId });
  }
  const user = currentUser(req);
  if (!user?.id) return res.status(401).json({ success: false, code: 'AUTH_REQUIRED', msg: '登录状态已失效，请重新登录', requestId: req.requestId });
  const now = Date.now();
  db.prepare('DELETE FROM agent_idempotency WHERE expires_at<=?').run(now);
  const route = req.path;
  const requestHash = agentRequestHash(req);
  const existing = db.prepare('SELECT request_hash, response_json, status_code FROM agent_idempotency WHERE user_id=? AND route=? AND idempotency_key=?')
    .get(user.id, route, key);
  if (existing) {
    if (existing.request_hash !== requestHash) return res.status(409).json({ success: false, code: 'IDEMPOTENCY_CONFLICT', msg: '同一请求标识不能用于不同参数', requestId: req.requestId });
    if (existing.response_json) {
      res.setHeader('Idempotency-Replayed', 'true');
      return res.status(existing.status_code || 200).json(JSON.parse(existing.response_json));
    }
    return res.status(409).json({ success: false, code: 'IDEMPOTENCY_IN_PROGRESS', msg: '相同请求正在处理，请稍后重试，不要重复点击', requestId: req.requestId });
  }
  db.prepare(`INSERT INTO agent_idempotency (user_id, route, idempotency_key, request_hash, created_at, expires_at)
    VALUES (?,?,?,?,?,?)`).run(user.id, route, key, requestHash, now, now + AGENT_IDEMPOTENCY_TTL_MS);
  const originalJson = res.json.bind(res);
  let persisted = false;
  res.json = body => {
    const statusCode = res.statusCode || 200;
    db.prepare(`UPDATE agent_idempotency SET response_json=?, status_code=?
      WHERE user_id=? AND route=? AND idempotency_key=?`).run(JSON.stringify(body), statusCode, user.id, route, key);
    persisted = true;
    return originalJson(body);
  };
  res.on('finish', () => {
    if (!persisted) db.prepare('DELETE FROM agent_idempotency WHERE user_id=? AND route=? AND idempotency_key=?').run(user.id, route, key);
  });
  next();
}

// 旧的产品管理客户端未必传此头；网页端传入时获得安全重试，不改变旧 API 契约。
function optionalBrowserIdempotency(req, res, next) {
  if (!req.get('idempotency-key')) return next();
  return requireBrowserIdempotency(req, res, next);
}

const AGENT_READ_API_PATHS = [
  /^\/products$/,
  /^\/products\/\d+\/content$/,
  /^\/batches\/\d+\/trace$/,
  /^\/codes$/,
  /^\/codes\/unbound$/,
  /^\/codes\/box\/[^/]+$/,
  /^\/operation_logs$/,
  /^\/distributors$/,
  /^\/shipments$/,
  /^\/alerts$/,
  /^\/users$/,
  /^\/factories$/,
  /^\/stats$/,
  /^\/invitations$/,
  /^\/brands$/,
  /^\/campaigns$/,
  /^\/prizes$/
];
const currentUser = req => req.agentUser || req.session.user || null;

// Explicit read-only bridge to existing domain APIs. This expands what an
// Agent can inspect without silently granting destructive browser actions.
app.use('/api', (req, res, next) => {
  if (req.method !== 'GET' || !AGENT_READ_API_PATHS.some(pattern => pattern.test(req.path))) return next();
  if (!String(req.get('authorization') || '').startsWith('Bearer ')) return next();
  return requireAgentToken(req, res, next);
});

// 所有视图可用的公共变量：当前用户、未处理预警数
app.use((req, res, next) => {
  res.locals.user = req.session.user || null;
  res.locals.alertsUnread = 0;
  res.locals.brand = '穿山甲溯源大师';
  res.locals.icon = (name, className = '') => {
    const allowed = new Set(['tag','home','grid','alert','user','box','camera','download','print','trash','lock','clipboard','bell','settings','truck','handshake','location','refresh','check','search','gift','ticket','database','video','cart','chevron-right','chevron-left','arrow-right','arrow-left','plus','xmark']);
    const safeName = allowed.has(name) ? name : 'grid';
    const safeClass = String(className).replace(/[^a-zA-Z0-9 _-]/g, '');
    return `<svg class="ui-icon ${safeClass}" aria-hidden="true"><use href="/icons/ui.svg#${safeName}"></use></svg>`;
  };
  if (req.session.user) {
    try {
      const scopeSet = brandScopeSet(req);
      if (scopeSet === null) {
        res.locals.alertsUnread = db.prepare('SELECT COUNT(*) as c FROM alerts WHERE handled=0').get().c;
      } else {
        const vals = brandSetValues(scopeSet);
        res.locals.alertsUnread = db.prepare(`SELECT COUNT(*) as c FROM alerts WHERE handled=0 AND brand_id IN (${vals.map(() => '?').join(',')})`).get(...vals).c;
      }
    } catch (e) {}
  }
  // 品牌名（顶栏 logo 文字，所有页面统一显示）
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key=?').get('brand_name');
    if (row && row.value) res.locals.brand = row.value;
  } catch (e) {}
  next();
});

// ===================== 全局禁用浏览器缓存（强制刷新 iOS 风格新版） =====================
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
});

// ===================== 认证守卫 =====================
// 页面守卫：未登录跳登录页；API 守卫：返回 401
function requireLogin(req, res, next) {
  if (currentUser(req)) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ success: false, msg: '请先登录', needLogin: true });
  return res.redirect('/login');
}
// 角色守卫：requireRole('admin') / requireRole('admin','warehouse')
function requireRole(...roles) {
  return (req, res, next) => {
    const user = currentUser(req);
    if (!user) {
      if (req.path.startsWith('/api/')) return res.status(401).json({ success: false, msg: '请先登录', needLogin: true });
      return res.redirect('/login');
    }
    if (!readOnlyAccess.roleAllowed(roles, user.role, req.method)) {
      if (req.path.startsWith('/api/')) return res.status(403).json({ success: false, msg: '没有权限执行此操作' });
      return res.status(403).send('没有权限访问该页面，<a href="/">返回首页</a>');
    }
    next();
  };
}
// 401 时前端跳登录页（供 fetch 全局处理）
const ROLE_NAMES = { AUDIT_VIEWER: '只读体验账号', admin: '平台管理员', brand: '品牌管理员', brand_staff: '品牌方工作账号', factory: '工厂装箱', warehouse: '品牌方', distributor: '代理商' };
const PASSWORD_POLICY_MESSAGE = '密码至少12位，包含大小写字母、数字和符号';
function passwordMeetsPolicy(value) {
  const password = String(value || '');
  return password.length >= 12 && /[a-z]/.test(password) && /[A-Z]/.test(password) && /[0-9]/.test(password) && /[^A-Za-z0-9\s]/.test(password);
}

// ===================== 品牌数据隔离（SaaS 多租户） =====================
// brandScope(req)：返回 null 表示平台管理员（不限制，看全部品牌）；
// 返回数字表示该账号归属的品牌（所有查询只看该品牌数据）
function brandScope(req) {
  const u = req.agentUser || req.session.user;
  if (!u) return undefined;
  if (u.role === 'admin' || u.role === readOnlyAccess.ROLE) return null;
  const brandId = Number(u.brand_id);
  return Number.isInteger(brandId) && brandId > 0 ? brandId : 0;
}
// 校验某个 brand_id 是否在当前账号的数据范围内
function brandAllowed(scope, brand_id) {
  return scope === null || Number(brand_id) === Number(scope);
}
// 账号**归属品牌** id 集合：user_brands 关联表（多选）∪ 主品牌 users.brand_id（兜底）。
// 与角色无关：admin 也可能被指定归属品牌，也可能一个都没有（全局超管）。
function userOwnerBrandIds(u) {
  if (!u || !u.id) return [];
  let set = [];
  set = db.prepare('SELECT brand_id FROM user_brands WHERE user_id=?').all(u.id).map(r => Number(r.brand_id));
  const main = Number(u.brand_id);
  if (Number.isInteger(main) && main > 0) set.push(main);
  return [...new Set(set.filter(x => Number.isInteger(x) && x > 0))];
}
// 全部启用品牌 id（全局账号的品牌选项兜底：它没有归属品牌，但不能没得选）
function enabledBrandIds() {
  return db.prepare('SELECT id FROM brands WHERE enabled=1 ORDER BY id').all().map(r => Number(r.id));
}
// 当前账号可访问的品牌 id 集合（多品牌归属）。admin 返回 null=全部；
// 其余角色按 user_brands 关联表返回集合（含主品牌 brand_id 作为兜底）。
function brandScopeSet(req) {
  const u = req.agentUser || req.session.user;
  if (!u) return undefined;
  if (u.role === 'admin' || u.role === readOnlyAccess.ROLE) return null;
  return userOwnerBrandIds(u);
}
// 判断 brand_id 是否在给定品牌集合内；collection=null 表示不限制（全部）
function brandInSet(collection, brand_id) {
  if (collection === null) return true;
  const bid = Number(brand_id);
  return Array.isArray(collection) && collection.some(x => Number(x) === bid);
}
// 代理商的品牌集合（多品牌匹配）：兼容字段 distributors.brand_id 视为主品牌一并纳入，
// 避免只有关联表、没回填兼容字段的历史数据被漏掉。
function distributorBrandIdList(distributor) {
  if (!distributor) return [];
  let ids = [];
  try {
    ids = db.prepare('SELECT brand_id FROM distributor_brands WHERE distributor_id=?')
      .all(distributor.id).map(r => Number(r.brand_id));
  } catch (e) { ids = []; }
  const main = Number(distributor.brand_id);
  if (Number.isInteger(main) && main > 0) ids.push(main);
  return [...new Set(ids.filter(id => Number.isInteger(id) && id > 0))];
}
// 账号能否操作该代理商：代理商匹配的**任一**品牌落在账号品牌范围内即可。
// 这是发货链路（代理商下拉 / 单码发货 / 批量发货 / 报表）唯一的判定口径。
function distributorInScope(scopeSet, distributor) {
  if (!distributor) return false;
  if (scopeSet === null) return true;
  return distributorBrandIdList(distributor).some(id => brandInSet(scopeSet, id));
}
// 把品牌集合转成 SQL IN 片段值（空集合返回 [0] 兜底，避免 IN () 语法错误）
function brandSetValues(collection) {
  if (collection === null) return null;
  const arr = Array.isArray(collection) ? collection : [];
  return arr.length ? arr : [0];
}
// 品牌集合的 SQL 过滤片段：管理员（null）不限制；否则返回 ` AND <column> IN (?,?,...)`。
// 参数请用 brandSetValues(scopeSet) 展开，两者必须配套使用。
function brandSqlFilter(scopeSet, column = 'brand_id') {
  if (scopeSet === null) return '';
  const vals = brandSetValues(scopeSet);
  return ` AND ${column} IN (${vals.map(() => '?').join(',')})`;
}
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// async 路由包装器：捕获 Promise 拒绝，交给全局错误中间件，避免请求挂死
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const scanSourceId = value => crypto.createHmac('sha256', SESSION_SECRET)
  .update(`scan:${String(value || 'unknown')}`).digest('hex').slice(0, 20);
const displayScanSource = value => /^[a-f0-9]{20}$/i.test(String(value || '')) ? String(value) : (value ? '历史记录已隐藏' : '');

// ===================== 登录 / 登出 =====================

app.get('/.well-known/reliacode-agent.json', (req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.json({
    service: 'ReliaCode Agent API',
    version: '1.2',
    authentication: {
      type: 'password_exchange',
      endpoint: '/api/agent/login',
      token_type: 'Bearer',
      token_ttl_seconds: AGENT_TOKEN_TTL_MS / 1000
    },
    endpoints: {
      discovery: '/.well-known/reliacode-agent.json',
      login: '/api/agent/login',
      current_identity: '/api/agent/me',
      capabilities: '/api/agent/capabilities',
      generate_boxes: '/api/agent/codes/boxes',
      generate_items: '/api/agent/codes/items',
      product_media: '/api/agent/products/:id/media',
      product_trace_template: '/api/agent/products/:id/trace-template',
      product_batches: '/api/agent/products/:id/batches',
      batch_trace: '/api/agent/batches/:batchId/trace',
      product_marketing: '/api/agent/products/:id/marketing',
      logout: '/api/agent/logout'
    },
    requirements: {
      content_type: 'application/json',
      mutation_header: 'Idempotency-Key',
      allowed_roles: ['admin', 'brand', 'brand_staff'],
      authorization: 'Every endpoint retains the account role and tenant boundary'
    },
    inspection: {
      products: 'GET /api/products',
      codes: 'GET /api/codes',
      unbound_codes: 'GET /api/codes/unbound',
      box_contents: 'GET /api/codes/box/:code',
      shipments: 'GET /api/shipments',
      alerts: 'GET /api/alerts',
      operation_logs: 'GET /api/operation_logs',
      distributors: 'GET /api/distributors',
      users: 'GET /api/users',
      factories: 'GET /api/factories',
      stats: 'GET /api/stats'
    }
  });
});

app.get('/api/agent/capabilities', requireAgentToken, (req, res) => {
  const role = req.agentUser.role;
  const can = roles => roles.includes(role);
  const reads = [
    can(['admin', 'factory', 'brand', 'brand_staff']) && 'GET /api/products',
    can(['admin', 'factory', 'brand', 'brand_staff']) && 'GET /api/products/:id/content',
    can(['admin', 'factory', 'brand', 'brand_staff']) && 'GET /api/batches/:batchId/trace',
    can(['admin', 'brand', 'brand_staff']) && 'GET /api/codes',
    can(['admin', 'brand', 'brand_staff']) && 'GET /api/codes/unbound',
    can(['admin', 'brand', 'brand_staff']) && 'GET /api/codes/box/:code',
    can(['admin', 'warehouse', 'brand']) && 'GET /api/shipments',
    can(['admin', 'brand', 'brand_staff']) && 'GET /api/alerts',
    can(['admin', 'brand', 'brand_staff']) && 'GET /api/operation_logs',
    can(['admin', 'brand', 'brand_staff']) && 'GET /api/distributors',
    can(['admin', 'brand']) && 'GET /api/users',
    can(['admin', 'brand']) && 'GET /api/factories',
    can(['admin', 'brand', 'brand_staff']) && 'GET /api/stats'
  ].filter(Boolean);
  const mutations = [
    can(['admin', 'brand_staff']) && 'POST /api/agent/codes/items',
    can(['admin', 'brand_staff']) && 'POST /api/agent/codes/boxes',
    can(['admin', 'brand', 'brand_staff']) && 'PUT /api/agent/products/:id/media',
    can(['admin', 'brand', 'brand_staff']) && 'PUT /api/agent/products/:id/trace-template',
    can(['admin', 'brand', 'brand_staff']) && 'POST /api/agent/products/:id/batches',
    can(['admin', 'brand', 'brand_staff']) && 'POST /api/agent/batches/:batchId/trace',
    can(['admin', 'brand', 'brand_staff']) && 'PUT /api/agent/products/:id/marketing'
  ].filter(Boolean);
  res.setHeader('Cache-Control', 'no-store');
  res.json({ success: true, role, reads, mutations, mutation_header: 'Idempotency-Key' });
});

function agentLoginRateLimit(req, res, next) {
  const now = Date.now();
  const entries = [loginSourceHash(req), loginAccountHash(req)].map(key => recordLoginAttempt(key, now));
  const limited = entries.find(entry => entry.attemptCount > LOGIN_MAX_ATTEMPTS);
  if (!limited) return next();
  res.setHeader('Retry-After', String(Math.max(1, Math.ceil((limited.resetAt - now) / 1000))));
  return res.status(429).json({ success: false, code: 'AGENT_LOGIN_RATE_LIMITED', msg: '登录尝试过多，请稍后再试', requestId: req.requestId });
}

app.post('/api/agent/login', agentLoginRateLimit, (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  const clientName = String(req.body.client_name || 'agent').trim().slice(0, 80) || 'agent';
  const user = username ? db.prepare('SELECT * FROM users WHERE username=?').get(username) : null;
  if (!user || !user.enabled || !verifyPassword(password, user.password_hash)) {
    return res.status(401).json({ success: false, code: 'AGENT_LOGIN_FAILED', msg: '账号或密码错误', requestId: req.requestId });
  }
  if (!['admin', 'brand', 'brand_staff'].includes(user.role)) {
    return res.status(403).json({ success: false, code: 'AGENT_ROLE_FORBIDDEN', msg: '该账号没有生码权限', requestId: req.requestId });
  }
  let brandInfo = null;
  if (user.brand_id) {
    brandInfo = db.prepare('SELECT id, name, enabled FROM brands WHERE id=?').get(user.brand_id);
    if (!brandInfo || !brandInfo.enabled) return res.status(403).json({ success: false, code: 'AGENT_TENANT_DISABLED', msg: '所属品牌不存在或已停用', requestId: req.requestId });
  }
  if (['brand', 'brand_staff'].includes(user.role) && !brandInfo) {
    return res.status(403).json({ success: false, code: 'AGENT_TENANT_REQUIRED', msg: '该账号未绑定品牌', requestId: req.requestId });
  }
  const now = Date.now();
  db.prepare('DELETE FROM agent_tokens WHERE expires_at<=? OR revoked_at IS NOT NULL').run(now);
  const token = `rca_${crypto.randomBytes(32).toString('base64url')}`;
  const result = db.prepare(`INSERT INTO agent_tokens (user_id, token_hash, client_name, scope, created_at, expires_at)
    VALUES (?,?,?,?,?,?)`).run(user.id, agentTokenHash(token), clientName, 'codes:generate', now, now + AGENT_TOKEN_TTL_MS);
  req.agentUser = {
    id: user.id,
    username: user.username,
    display_name: user.display_name || user.username,
    role: user.role,
    brand_id: user.brand_id || null,
    brand_name: brandInfo ? brandInfo.name : null
  };
  req.agentTokenId = Number(result.lastInsertRowid);
  deleteLoginLimit.run(loginSourceHash(req));
  deleteLoginLimit.run(loginAccountHash(req));
  logOperation(req, 'agent_login', 'agent_token', req.agentTokenId, `Agent 客户端「${clientName}」取得短期生码令牌`);
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    success: true,
    access_token: token,
    token_type: 'Bearer',
    expires_in: AGENT_TOKEN_TTL_MS / 1000,
    scope: 'codes:generate',
    user: { username: user.username, role: user.role, brand_id: user.brand_id || null, brand_name: brandInfo ? brandInfo.name : null }
  });
});

app.get('/api/agent/me', requireAgentToken, (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ success: true, user: req.agentUser, scope: 'codes:generate' });
});

app.post('/api/agent/logout', requireAgentToken, (req, res) => {
  db.prepare('UPDATE agent_tokens SET revoked_at=? WHERE id=?').run(Date.now(), req.agentTokenId);
  logOperation(req, 'agent_logout', 'agent_token', req.agentTokenId, 'Agent 短期令牌已撤销');
  res.json({ success: true });
});

app.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/');
  const brand = db.prepare("SELECT value FROM settings WHERE key='brand_name'").get()?.value || '穿山甲溯源大师';
  res.render('login', { brand, error: '' });
});

app.post('/login', loginRateLimit, (req, res, next) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  const rememberLogin = req.body.remember === '1';
  if (!username || !password) {
    return res.status(401).render('login', { brand: '穿山甲溯源大师', error: '请输入账号和密码' });
  }
  const user = db.prepare('SELECT * FROM users WHERE username=?').get(username);
  if (!user || !user.enabled || !verifyPassword(password, user.password_hash)) {
    return res.status(401).render('login', { brand: '穿山甲溯源大师', error: '账号或密码错误' });
  }
  // 代理商账号：绑定代理商信息快照
  let distributor = null;
  if (user.role === 'distributor') {
    distributor = db.prepare('SELECT * FROM distributors WHERE id=?').get(user.distributor_id);
    if (!distributor) return res.status(403).render('login', { brand: '穿山甲溯源大师', error: '该账号未绑定代理商，请联系管理员' });
  }
  // 工厂账号：绑定工厂信息快照
  let factory = null;
  if (user.role === 'factory') {
    factory = db.prepare('SELECT * FROM factories WHERE id=?').get(user.factory_id);
    if (!factory) return res.status(403).render('login', { brand: '穿山甲溯源大师', error: '该账号未绑定工厂，请联系管理员' });
    if (!factory.enabled) return res.status(403).render('login', { brand: '穿山甲溯源大师', error: '该工厂已停用，请联系品牌管理员' });
  }
  // 品牌信息快照（brand/warehouse/factory/distributor 均按品牌隔离）
  let brandInfo = null;
  if (user.brand_id) {
    brandInfo = db.prepare('SELECT * FROM brands WHERE id=?').get(user.brand_id);
    if (brandInfo && !brandInfo.enabled) {
      return res.status(403).render('login', { brand: '穿山甲溯源大师', error: '该品牌已被停用，请联系平台管理员' });
    }
  }
  if (['brand', 'brand_staff'].includes(user.role) && !brandInfo) {
    return res.status(403).render('login', { brand: '穿山甲溯源大师', error: '该账号未绑定品牌，请联系平台管理员' });
  }
  db.prepare(`UPDATE users SET last_login_at=datetime('now','localtime') WHERE id=?`).run(user.id);
  const sessionUser = {
    id: user.id,
    username: user.username,
    display_name: user.display_name || user.username,
    role: user.role,
    distributor_id: user.distributor_id || null,
    distributor_name: distributor ? distributor.name : null,
    factory_id: user.factory_id || null,
    factory_name: factory ? factory.name : null,
    brand_id: user.brand_id || null,
    brand_name: brandInfo ? brandInfo.name : null
  };
  req.session.regenerate((err) => {
    if (err) return next(err);
    req.session.user = sessionUser;
    req.session.cookie.maxAge = rememberLogin ? 30 * 24 * 60 * 60 * 1000 : 12 * 60 * 60 * 1000;
    deleteLoginLimit.run(loginSourceHash(req));
    deleteLoginLimit.run(loginAccountHash(req));
    const home = user.role === 'distributor' ? '/portal' : '/';
    res.redirect(home);
  });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ success: true }));
});
app.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect(303, '/login'));
});
app.get('/logout', (req, res) => {
  res.setHeader('Allow', 'POST');
  res.redirect(303, req.session.user ? '/' : '/login');
});

// ===================== 邀请码自助注册 =====================

// 注册页（公开，凭邀请码注册工厂/代理商账号）
app.get('/register', (req, res) => {
  if (req.session.user) return res.redirect('/');
  const brand = db.prepare("SELECT value FROM settings WHERE key='brand_name'").get()?.value || '穿山甲溯源大师';
  res.render('register', { brand, code: String(req.query.code || ''), error: '' });
});

// 邀请码校验（注册页输入邀请码后回显角色）
app.post('/api/register/check-code', registrationRateLimit, (req, res) => {
  const code = String(req.body.code || '').trim().toUpperCase();
  const inv = db.prepare('SELECT * FROM invitations WHERE code=?').get(code);
  if (!inv || inv.status !== 0) return res.status(409).json({ success: false, code: 'INVITATION_ALREADY_USED', msg: '邀请码无效或已被使用' });
  let factory_name = null;
  if (inv.role === 'factory' && inv.factory_id) {
    factory_name = db.prepare('SELECT name FROM factories WHERE id=? AND enabled=1').get(inv.factory_id)?.name || null;
    if (!factory_name) return res.status(409).json({ success: false, code: 'INVITATION_FACTORY_INACTIVE', msg: '邀请码绑定的工厂已停用，请联系管理员重新生成' });
  }
  res.json({ success: true, role: inv.role, note: inv.note, factory_name });
});

// 凭邀请码注册
app.post('/api/register', registrationRateLimit, (req, res) => {
  const code = String(req.body.code || '').trim().toUpperCase();
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  const company = String(req.body.company || '').trim();
  const contact = String(req.body.contact || '').trim();

  const inv = db.prepare('SELECT * FROM invitations WHERE code=?').get(code);
  if (!inv || inv.status !== 0) return res.status(409).json({ success: false, code: 'INVITATION_ALREADY_USED', msg: '邀请码无效或已被使用' });
  const selectedRegion = inv.role === 'distributor'
    ? normalizeRegionSelection(req.body.country, req.body.province, req.body.city)
    : null;
  if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) return res.json({ success: false, msg: '账号需为3-20位字母/数字/下划线' });
  if (!passwordMeetsPolicy(password)) return res.json({ success: false, msg: PASSWORD_POLICY_MESSAGE });
  // 工厂角色：工厂由邀请码固定，无需自填工厂名；其他角色（代理商/品牌）仍需 company
  if (!company && inv.role !== 'factory') return res.json({ success: false, msg: '请填写公司/工厂名称' });
  const phone = String(req.body.phone || '').trim();
  if (inv.role === 'factory') {
    // 工厂注册：联系人（人名）+ 11位手机号 必填；工厂由邀请码固定，无需填工厂名
    if (!contact) return res.json({ success: false, msg: '请填写联系人姓名' });
    if (!/^1\d{10}$/.test(phone)) return res.json({ success: false, msg: '请填写正确的11位手机号' });
  }
  if (inv.role === 'distributor' && !selectedRegion) return res.status(400).json({ success: false, code: 'INVALID_REGION_SELECTION', msg: '请选择有效的国家、省和市' });
  if (db.prepare('SELECT 1 FROM users WHERE username=?').get(username)) {
    return res.json({ success: false, msg: '该账号已被占用，请换一个' });
  }

  const register = db.transaction(() => {
    const claim = db.prepare(`UPDATE invitations SET status=1, used_by=?, used_at=datetime('now','localtime') WHERE id=? AND status=0`)
      .run(username, inv.id);
    if (claim.changes !== 1) throw new Error('INVITATION_ALREADY_USED');
    if (inv.role === 'factory') {
      // 工厂注册：绑定邀请码指定的已建档工厂（固定项）；人名存 display_name，手机号存 phone
      if (!inv.factory_id) throw new Error('INVITATION_FACTORY_INVALID');
      const fac = db.prepare('SELECT * FROM factories WHERE id=? AND enabled=1').get(inv.factory_id);
      if (!fac) throw new Error('INVITATION_FACTORY_INVALID');
      db.prepare('INSERT INTO users (username, password_hash, display_name, phone, role, factory_id, brand_id) VALUES (?,?,?,?,?,?,?)')
        .run(username, hashPassword(password), contact, phone, 'factory', inv.factory_id, inv.brand_id || null);
    } else if (inv.role === 'distributor') {
      // 代理商注册：创建代理商实体并绑定账号（归属邀请码对应品牌）
      const d = db.prepare('INSERT INTO distributors (name, phone, region, brand_id, country, province, city) VALUES (?,?,?,?,?,?,?)')
        .run(company, phone || contact, selectedRegion.region, inv.brand_id || null, selectedRegion.country, selectedRegion.province, selectedRegion.city);
      db.prepare('INSERT INTO users (username, password_hash, display_name, role, distributor_id, brand_id) VALUES (?,?,?,?,?,?)')
        .run(username, hashPassword(password), company, 'distributor', d.lastInsertRowid, inv.brand_id || null);
    } else if (inv.role === 'brand') {
      if (!inv.brand_id || !db.prepare('SELECT 1 FROM brands WHERE id=? AND enabled=1').get(inv.brand_id)) {
        throw new Error('INVITATION_BRAND_INVALID');
      }
      db.prepare('INSERT INTO users (username, password_hash, display_name, role, brand_id) VALUES (?,?,?,?,?)')
        .run(username, hashPassword(password), company, 'brand', inv.brand_id);
    } else {
      throw new Error('INVITATION_ROLE_INVALID');
    }
  });
  try {
    register();
    deleteLoginLimit.run(registrationSourceHash(req));
    res.json({ success: true, msg: '注册成功，请使用新账号登录', username });
  } catch (e) {
    if (e.message === 'INVITATION_ALREADY_USED') return res.status(409).json({ success: false, code: 'INVITATION_ALREADY_USED', msg: '邀请码无效或已被使用' });
    if (e.message === 'INVITATION_BRAND_INVALID' || e.message === 'INVITATION_ROLE_INVALID' || e.message === 'INVITATION_FACTORY_INVALID') return res.status(409).json({ success: false, code: e.message, msg: '邀请码工厂配置无效，请联系平台管理员' });
    if (String(e.code || '').startsWith('SQLITE_CONSTRAINT')) return res.status(409).json({ success: false, code: 'REGISTRATION_CONFLICT', msg: '账号或企业信息已存在' });
    console.error(JSON.stringify({ level: 'error', event: 'registration_failed', requestId: req.requestId, message: e.message }));
    res.status(500).json({ success: false, code: 'REGISTRATION_FAILED', msg: '注册失败，请稍后重试', requestId: req.requestId });
  }
});

// 邀请码列表（admin/brand；brand 只看自己品牌的邀请码）
app.get('/api/invitations', requireRole('admin', 'brand'), (req, res) => {
  const scopeSet = brandScopeSet(req);
  const invitations = scopeSet === null
    ? db.prepare(`
        SELECT i.id, i.code, i.role, i.note, i.status, i.used_by, i.used_at, i.created_at, b.name as brand_name, f.name as factory_name, u.display_name as user_name
        FROM invitations i LEFT JOIN brands b ON i.brand_id=b.id LEFT JOIN factories f ON i.factory_id=f.id LEFT JOIN users u ON i.used_by = u.username
        ORDER BY i.id DESC LIMIT 200
      `).all()
    : db.prepare(`
        SELECT i.id, i.code, i.role, i.note, i.status, i.used_by, i.used_at, i.created_at, b.name as brand_name, f.name as factory_name, u.display_name as user_name
        FROM invitations i LEFT JOIN brands b ON i.brand_id=b.id LEFT JOIN factories f ON i.factory_id=f.id LEFT JOIN users u ON i.used_by = u.username
        WHERE i.brand_id IN (${brandSetValues(scopeSet).map(() => '?').join(',')}) ORDER BY i.id DESC LIMIT 200
      `).all(...brandSetValues(scopeSet));
  res.json({ success: true, invitations });
});

// 生成邀请码（admin 可指定品牌；brand 只能生成自己品牌的工厂/代理商邀请码）
app.post('/api/invitations', requireRole('admin', 'brand'), (req, res) => {
  const role = req.body.role;
  const note = String(req.body.note || '').trim();
  const scopeSet = brandScopeSet(req);
  if (!['factory', 'distributor', 'brand'].includes(role)) return res.json({ success: false, msg: '角色不合法' });
  if (role === 'brand' && scopeSet !== null) return res.status(403).json({ success: false, msg: '只有平台管理员可以生成品牌管理员邀请码' });
  const requested = parseInt(req.body.brand_id) || null;
  let brand_id = scopeSet !== null
    ? (brandInSet(scopeSet, requested) ? requested : (brandSetValues(scopeSet)[0] ?? null))
    : requested;
  if (role === 'brand' && !brand_id) return res.status(400).json({ success: false, msg: '品牌管理员邀请码必须指定归属品牌' });
  if (brand_id && !db.prepare('SELECT 1 FROM brands WHERE id=? AND enabled=1').get(brand_id)) {
    return res.json({ success: false, msg: '所选品牌不存在或已停用' });
  }
  // 工厂注册码必须绑定已建档工厂（固定项，防止装箱人员乱填工厂名）
  let factory_id = null;
  if (role === 'factory') {
    factory_id = parseInt(req.body.factory_id) || null;
    if (!factory_id) return res.json({ success: false, msg: '工厂注册码必须选择归属工厂（请先在工厂管理建档）' });
    const fac = db.prepare('SELECT * FROM factories WHERE id=? AND enabled=1').get(factory_id);
    if (!fac) return res.json({ success: false, msg: '所选工厂不存在，请刷新后重试' });
    if (!brandInSet(scopeSet, fac.brand_id)) return res.json({ success: false, msg: '所选工厂不在你的品牌范围内' });
  }

  let code;
  do {
    code = 'INV' + crypto.randomBytes(12).toString('hex').toUpperCase();
  } while (db.prepare('SELECT 1 FROM invitations WHERE code=?').get(code));
  db.prepare('INSERT INTO invitations (code, role, note, brand_id, factory_id) VALUES (?,?,?,?,?)').run(code, role, note, brand_id, factory_id);
  const invitationRoleName = role === 'factory' ? '工厂' : (role === 'distributor' ? '代理商' : '品牌管理员');
  logOperation(req, 'create_invitation', 'invitation', code, `生成${invitationRoleName}邀请码「${code}」${brand_id ? '（品牌：' + (db.prepare('SELECT name FROM brands WHERE id=?').get(brand_id)?.name || '') + '）' : ''}`);
  res.json({ success: true, code, msg: '邀请码已生成' });
});

// 作废/删除邀请码（admin/brand；brand 只能操作自己品牌的邀请码）
app.delete('/api/invitations/:id', requireRole('admin', 'brand'), (req, res) => {
  const inv = db.prepare('SELECT * FROM invitations WHERE id=?').get(req.params.id);
  if (!inv) return res.json({ success: false, msg: '邀请码不存在' });
  if (!brandInSet(brandScopeSet(req), inv.brand_id)) return res.json({ success: false, msg: '没有权限操作该邀请码' });
  const roleText = inv.role === 'factory' ? '工厂' : '代理商';
  if (req.query.hard === '1') {
    db.prepare('DELETE FROM invitations WHERE id=?').run(inv.id);
    logOperation(req, 'delete_invitation', 'invitation', inv.code, `邀请码「${inv.code}」（${roleText}）记录已删除` + (inv.used_by ? `，已注册账号 ${inv.used_by} 不受影响` : ''));
    return res.json({ success: true, msg: '邀请码记录已删除' });
  }
  if (inv.status === 1) return res.json({ success: false, msg: '该邀请码已被使用，不能作废；如不需要可删除记录' });
  db.prepare('UPDATE invitations SET status=2 WHERE id=?').run(inv.id);
  logOperation(req, 'revoke_invitation', 'invitation', inv.code, `邀请码「${inv.code}」（${roleText}）已作废`);
  res.json({ success: true, msg: '已作废' });
});

// ===================== 品牌管理（平台管理员） =====================

function normalizeBrandFactoryIds(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(Number).filter(id => Number.isInteger(id) && id > 0))];
}
function validateBrandFactoryIds(factoryIds) {
  if (!factoryIds.length) return '';
  const placeholders = factoryIds.map(() => '?').join(',');
  const count = db.prepare(`SELECT COUNT(*) c FROM factories WHERE id IN (${placeholders})`).get(...factoryIds).c;
  return count === factoryIds.length ? '' : '所选工厂不存在，请刷新后重试';
}
function replaceBrandFactories(brandId, factoryIds) {
  const nextIds = normalizeBrandFactoryIds(factoryIds);
  const nextSet = new Set(nextIds);
  const primaryFactories = db.prepare('SELECT id,name FROM factories WHERE brand_id=?').all(brandId);
  const replacements = new Map();
  const findReplacement = db.prepare(`SELECT fb.brand_id FROM factory_brands fb
    JOIN brands b ON b.id=fb.brand_id
    WHERE fb.factory_id=? AND fb.brand_id<>?
    ORDER BY b.enabled DESC,fb.created_at,fb.brand_id LIMIT 1`);
  for (const factory of primaryFactories) {
    if (nextSet.has(Number(factory.id))) continue;
    const replacement = findReplacement.get(factory.id, brandId);
    if (!replacement) {
      const error = new Error(`工厂“${factory.name}”至少要保留一个归属品牌，请先把它关联到其他品牌`);
      error.code = 'FACTORY_REQUIRES_BRAND';
      throw error;
    }
    replacements.set(Number(factory.id), Number(replacement.brand_id));
  }
  db.prepare('DELETE FROM factory_brands WHERE brand_id=?').run(brandId);
  const insert = db.prepare('INSERT OR IGNORE INTO factory_brands (factory_id,brand_id) VALUES (?,?)');
  nextIds.forEach(factoryId => insert.run(factoryId, brandId));
  const setPrimary = db.prepare('UPDATE factories SET brand_id=? WHERE id=?');
  replacements.forEach((replacementBrandId, factoryId) => setPrimary.run(replacementBrandId, factoryId));
  nextIds.forEach(factoryId => {
    const factory = db.prepare('SELECT brand_id FROM factories WHERE id=?').get(factoryId);
    if (!factory?.brand_id) setPrimary.run(brandId, factoryId);
  });
  return nextIds;
}

app.get('/api/brands', requireRole('admin'), (req, res) => {
  const brands = db.prepare(`SELECT b.*,
      (SELECT COUNT(*) FROM products p WHERE p.brand_id=b.id) as product_count,
      (SELECT COUNT(DISTINCT f.id) FROM factories f LEFT JOIN factory_brands fb ON fb.factory_id=f.id WHERE f.brand_id=b.id OR fb.brand_id=b.id) as factory_count,
      (SELECT COUNT(*) FROM distributors d WHERE d.brand_id=b.id
        OR EXISTS (SELECT 1 FROM distributor_brands dbx WHERE dbx.distributor_id=d.id AND dbx.brand_id=b.id)) as distributor_count,
      (SELECT COUNT(*) FROM users u WHERE u.brand_id=b.id
        OR EXISTS (SELECT 1 FROM user_brands ubx WHERE ubx.user_id=u.id AND ubx.brand_id=b.id)) as user_count
    FROM brands b ORDER BY b.id`).all();
  const factoryMap = {};
  db.prepare(`SELECT fb.brand_id,f.id,f.name FROM factory_brands fb
    JOIN factories f ON f.id=fb.factory_id ORDER BY f.name,f.id`).all().forEach(factory => {
    (factoryMap[factory.brand_id] = factoryMap[factory.brand_id] || []).push({ id: Number(factory.id), name: factory.name });
  });
  brands.forEach(brand => {
    brand.factories = factoryMap[brand.id] || [];
    brand.factory_ids = brand.factories.map(factory => factory.id);
  });
  const allFactories = db.prepare('SELECT id,name FROM factories WHERE enabled=1 ORDER BY name').all();
  res.json({ success: true, brands, factories: allFactories });
});

app.post('/api/brands', requireRole('admin'), (req, res) => {
  const name = String(req.body.name || '').trim();
  const contact = String(req.body.contact || '').trim();
  if (req.body.factory_ids !== undefined && !Array.isArray(req.body.factory_ids)) return res.status(400).json({ success: false, msg: '工厂选择格式不正确' });
  const factoryIds = normalizeBrandFactoryIds(req.body.factory_ids || []);
  if (!name) return res.status(400).json({ success: false, msg: '品牌名称不能为空' });
  if (db.prepare('SELECT 1 FROM brands WHERE name=?').get(name)) return res.status(409).json({ success: false, msg: '品牌名称已存在' });
  const factoryError = validateBrandFactoryIds(factoryIds);
  if (factoryError) return res.status(400).json({ success: false, msg: factoryError });
  let result;
  db.transaction(() => {
    result = db.prepare('INSERT INTO brands (name,contact) VALUES (?,?)').run(name, contact);
    replaceBrandFactories(Number(result.lastInsertRowid), factoryIds);
  })();
  logOperation(req, 'create_brand', 'brand', result.lastInsertRowid, `品牌「${name}」已创建`);
  res.status(201).json({ success: true, id: result.lastInsertRowid, factory_ids: factoryIds, msg: '品牌已创建' });
});

app.put('/api/brands/:id', requireRole('admin'), (req, res) => {
  const brand = db.prepare('SELECT * FROM brands WHERE id=?').get(req.params.id);
  if (!brand) return res.status(404).json({ success: false, msg: '品牌不存在' });
  const nextName = req.body.name === undefined ? brand.name : String(req.body.name || '').trim();
  if (!nextName) return res.status(400).json({ success: false, msg: '品牌名称不能为空' });
  if (db.prepare('SELECT 1 FROM brands WHERE name=? AND id<>?').get(nextName, brand.id)) return res.status(409).json({ success: false, msg: '品牌名称已存在' });
  if (req.body.factory_ids !== undefined && !Array.isArray(req.body.factory_ids)) return res.status(400).json({ success: false, msg: '工厂选择格式不正确' });
  const factoryIds = req.body.factory_ids === undefined ? null : normalizeBrandFactoryIds(req.body.factory_ids);
  const factoryError = factoryIds === null ? '' : validateBrandFactoryIds(factoryIds);
  if (factoryError) return res.status(400).json({ success: false, msg: factoryError });
  try {
    db.transaction(() => {
      db.prepare('UPDATE brands SET name=?,contact=?,enabled=? WHERE id=?').run(
        nextName,
        req.body.contact === undefined ? brand.contact : String(req.body.contact || '').trim(),
        req.body.enabled === undefined ? brand.enabled : (req.body.enabled ? 1 : 0),
        brand.id
      );
      if (factoryIds !== null) replaceBrandFactories(brand.id, factoryIds);
    })();
  } catch (error) {
    if (error.code === 'FACTORY_REQUIRES_BRAND') return res.status(409).json({ success: false, code: error.code, msg: error.message });
    throw error;
  }
  logOperation(req, req.body.enabled === undefined ? 'edit_brand' : 'toggle_brand', 'brand', brand.id,
    req.body.enabled === undefined ? `品牌「${nextName}」信息已更新` : `品牌「${nextName}」已${req.body.enabled ? '启用' : '停用'}`);
  const savedFactoryIds = db.prepare('SELECT factory_id FROM factory_brands WHERE brand_id=? ORDER BY factory_id').all(brand.id).map(row => row.factory_id);
  res.json({ success: true, factory_ids: savedFactoryIds, msg: '品牌已更新' });
});

// 删除空品牌。存在任何业务、账号或审计数据时必须停用，禁止级联抹除历史。
app.delete('/api/brands/:id', requireRole('admin'), (req, res) => {
  const brand = db.prepare('SELECT * FROM brands WHERE id=?').get(req.params.id);
  if (!brand) return res.status(404).json({ success: false, msg: '品牌不存在' });
  const dependentTables = [
    'users', 'user_brands', 'factories', 'factory_brands', 'products', 'distributors', 'distributor_brands', 'invitations', 'boxes', 'items',
    'scan_logs', 'alerts', 'operation_logs', 'product_media', 'product_trace_templates',
    'product_batches', 'batch_trace_entries', 'product_marketing', 'code_packages'
  ];
  const dependency = dependentTables.find(table => db.prepare(`SELECT 1 FROM ${table} WHERE brand_id=? LIMIT 1`).get(brand.id));
  if (dependency) return res.status(409).json({ success: false, code: 'BRAND_NOT_EMPTY', msg: '该品牌已有账号或业务历史，不能删除；请改为停用' });
  db.prepare('DELETE FROM brands WHERE id=?').run(brand.id);
  logOperation(req, 'delete_brand', 'brand', brand.id, `空品牌「${brand.name}」已删除`);
  res.json({ success: true, msg: '品牌已删除' });
});

// ===================== 页面路由 =====================

// 管理后台首页（按角色分流：工厂→装箱页，仓库→发货页，代理商→自助端；品牌管理员→品牌版首页）
app.get('/', requireLogin, (req, res) => {
  const role = req.session.user.role;
  if (role === 'factory') return res.redirect('/factory');
  if (role === 'warehouse') return res.redirect('/warehouse');
  if (role === 'distributor') return res.redirect('/portal');
  // admin 看全局，brand 只看自己品牌
  const scopeSet = brandScopeSet(req);
  const bp = brandSqlFilter(scopeSet, 'p.brand_id');
  const bcond = brandSqlFilter(scopeSet, 'b.brand_id');
  const bparam = scopeSet === null ? [] : brandSetValues(scopeSet);
  const pparam = scopeSet === null ? [] : brandSetValues(scopeSet);
  const p2param = scopeSet === null ? [] : brandSetValues(scopeSet);
  const stats = {
    products: db.prepare(`SELECT COUNT(*) as c FROM products p WHERE 1=1 ${bp}`).get(...pparam).c,
    boxes: db.prepare(`SELECT COUNT(*) as c FROM boxes b JOIN products p ON b.product_id=p.id WHERE 1=1 ${bp}`).get(...pparam).c,
    items: db.prepare(`SELECT COUNT(*) as c FROM items i JOIN products p ON i.product_id=p.id WHERE 1=1 ${bp}`).get(...pparam).c,
    // 口径同 /api/brands：按「代理商品牌集合」算，而不是只看兼容单字段。
    distributors: scopeSet === null
      ? db.prepare('SELECT COUNT(*) as c FROM distributors').get().c
      : db.prepare(`SELECT COUNT(*) as c FROM distributors d
          WHERE d.brand_id IN (${brandSetValues(scopeSet).map(() => '?').join(',')})
             OR EXISTS (SELECT 1 FROM distributor_brands dbx WHERE dbx.distributor_id=d.id AND dbx.brand_id IN (${brandSetValues(scopeSet).map(() => '?').join(',')}))`)
          .get(...brandSetValues(scopeSet), ...brandSetValues(scopeSet)).c,
    shipped: db.prepare(`SELECT COUNT(*) as c FROM boxes b JOIN products p ON b.product_id=p.id WHERE b.status='shipped' ${bp}`).get(...pparam).c,
    scanned: db.prepare(`SELECT COUNT(*) as c FROM items i JOIN products p ON i.product_id=p.id WHERE i.scanned_at IS NOT NULL ${bp}`).get(...pparam).c,
    inStockBoxes: db.prepare(`SELECT COUNT(*) as c FROM boxes b JOIN products p ON b.product_id=p.id WHERE b.status='in_stock' ${bp}`).get(...pparam).c,
    inStockItems: db.prepare(`SELECT COUNT(*) as c FROM items i JOIN products p ON i.product_id=p.id WHERE i.status='in_stock' ${bp}`).get(...pparam).c,
    diversions: db.prepare(`SELECT COUNT(*) as c FROM scan_logs WHERE is_diversion>0 ${brandSqlFilter(scopeSet)}`).get(...bparam).c,
  };
  const recentScans = scopeSet === null
    ? db.prepare('SELECT * FROM scan_logs ORDER BY scanned_at DESC LIMIT 10').all()
    : db.prepare(`SELECT * FROM scan_logs WHERE brand_id IN (${brandSetValues(scopeSet).map(() => '?').join(',')}) ORDER BY scanned_at DESC LIMIT 10`).all(...brandSetValues(scopeSet));
  // 扫码地区排行榜（仪表盘看板）：按扫码位置统计次数
  const scanRegions = scopeSet === null
    ? db.prepare("SELECT COALESCE(NULLIF(scan_location,''),'未知') as region, COUNT(*) as count FROM scan_logs GROUP BY region ORDER BY count DESC LIMIT 12").all()
    : db.prepare(`SELECT COALESCE(NULLIF(scan_location,''),'未知') as region, COUNT(*) as count FROM scan_logs WHERE brand_id IN (${brandSetValues(scopeSet).map(() => '?').join(',')}) GROUP BY region ORDER BY count DESC LIMIT 12`).all(...brandSetValues(scopeSet));
  const totalScans = scopeSet === null
    ? db.prepare('SELECT COUNT(*) as c FROM scan_logs').get().c
    : db.prepare(`SELECT COUNT(*) as c FROM scan_logs WHERE brand_id IN (${brandSetValues(scopeSet).map(() => '?').join(',')})`).get(...brandSetValues(scopeSet)).c;
  // 仓库手机入口 + 工厂手机入口（工人手机扫码直接打开）
  const baseUrl = getBaseUrl(req);
  const entryUrl = `${baseUrl}/warehouse`;
  const factoryUrl = `${baseUrl}/factory`;
  res.render('admin', { stats, recentScans, scanRegions, totalScans, entryUrl, factoryUrl });
});

// 业务导航页（admin/brand 专用 - 移动端底部「业务」Tab 入口）
app.get('/admin/business', requireRole('admin', 'brand', 'brand_staff'), (req, res) => {
  res.render('admin-business');
});

// 我的导航页（admin/brand 专用 - 移动端底部「我的」Tab 入口）
app.get('/admin/me', requireRole('admin', 'brand', 'brand_staff'), (req, res) => {
  res.render('admin-me');
});

// 码生成页面（brand 只看自己品牌的产品和工厂）
app.get('/generate', requireRole('admin', 'brand', 'brand_staff'), (req, res) => {
  const scopeSet = brandScopeSet(req);
  const productRows = scopeSet === null
    ? db.prepare(`
        SELECT p.*, f.name as factory_name, b.name as brand_name FROM products p
        LEFT JOIN factories f ON p.factory_id = f.id
        LEFT JOIN brands b ON p.brand_id = b.id
        ORDER BY p.id DESC
      `).all()
    : db.prepare(`
        SELECT p.*, f.name as factory_name, b.name as brand_name FROM products p
        LEFT JOIN factories f ON p.factory_id = f.id
        LEFT JOIN brands b ON p.brand_id = b.id
        WHERE p.brand_id IN (${brandSetValues(scopeSet).map(() => '?').join(',')})
        ORDER BY p.id DESC
      `).all(...brandSetValues(scopeSet));
  const products = withProductsFactories(productRows);
  const factories = db.prepare('SELECT id, name, brand_id FROM factories WHERE enabled=1 ORDER BY id DESC').all()
    .map(factory => ({ ...factory, brand_ids: [...factoryBrandSet(factory.id)] }))
    .filter(factory => scopeSet === null || factory.brand_ids.some(id => brandInSet(scopeSet, id)));
  const brands = db.prepare('SELECT id, name FROM brands WHERE enabled=1 ORDER BY id').all()
    .filter(brand => brandInSet(scopeSet, brand.id));
  res.render('generate', { products, factories, brands });
});

// 仓库发货扫码页面（brand 发货时只能选自己品牌的代理商）
app.get('/warehouse', requireRole('admin', 'warehouse', 'brand', 'brand_staff'), (req, res) => {
  const scopeSet = brandScopeSet(req);
  // 代理商下拉：多品牌匹配的代理商（distributor_brands）也必须出现，
  // 否则「档案里匹配了多个品牌」的代理商在发货页根本选不到（与 r23 的取数口径同一教训）。
  const distVals = scopeSet === null ? [] : brandSetValues(scopeSet);
  const distPh = distVals.map(() => '?').join(',');
  const distributors = scopeSet === null
    ? db.prepare('SELECT * FROM distributors ORDER BY id DESC').all()
    : db.prepare(`SELECT * FROM distributors d WHERE d.brand_id IN (${distPh})
        OR EXISTS (SELECT 1 FROM distributor_brands db3 WHERE db3.distributor_id=d.id AND db3.brand_id IN (${distPh}))
        ORDER BY d.id DESC`).all(...distVals, ...distVals);
  res.render('warehouse', { distributors });
});

// 工厂装箱扫码页面（数据隔离：工厂只见自己工厂的产品；品牌管理员见本品牌全部产品）
app.get('/factory', requireRole('admin', 'factory', 'brand', 'brand_staff'), (req, res) => {
  let sql = 'SELECT * FROM products WHERE 1=1';
  const params = [];
  const role = req.session.user.role;
  if (role === 'factory' && req.session.user.factory_id) {
    // 与 /api/products 共用 factoryPackBrands()，两处口径必须一致，否则
    // 页面首屏与后续 fetch 拿到的产品集合会不同。
    const packBrands = factoryPackBrands(req, req.session.user.factory_id);
    if (!packBrands.length) sql += ' AND 1=0';
    else {
      sql += ` AND brand_id IN (${packBrands.map(() => '?').join(',')}) AND (
        EXISTS (SELECT 1 FROM product_factories pf WHERE pf.product_id=products.id AND pf.factory_id=?)
        OR (NOT EXISTS (SELECT 1 FROM product_factories pf0 WHERE pf0.product_id=products.id) AND factory_id=?)
      )`;
      params.push(...packBrands, req.session.user.factory_id, req.session.user.factory_id);
    }
  } else if (['brand', 'brand_staff'].includes(role)) {
    const ownerSet = brandScopeSet(req);
    if (ownerSet !== null) {
      sql += brandSqlFilter(ownerSet);
      params.push(...brandSetValues(ownerSet));
    }
  }
  sql += ' ORDER BY id DESC';
  const products = db.prepare(sql).all(...params);
  const scopeSet = brandScopeSet(req);
  const factories = scopeSet === null
    ? db.prepare('SELECT id,name,brand_id FROM factories WHERE enabled=1 ORDER BY name,id').all()
    : db.prepare(`SELECT id,name,brand_id FROM factories WHERE brand_id IN (${brandSetValues(scopeSet).map(() => '?').join(',')}) AND enabled=1 ORDER BY name,id`).all(...brandSetValues(scopeSet));
  res.render('factory', { products, factories });
});

// 代理商管理页面（brand 只看自己品牌；admin 建代理商时可选归属品牌）
app.get('/distributors', requireRole('admin', 'brand', 'brand_staff'), (req, res) => {
  const scope = brandScope(req);
  const scopeSet = brandScopeSet(req);
  const base = `SELECT d.*, b.name as brand_name,
    (SELECT group_concat(bx.name, '、') FROM distributor_brands db2 JOIN brands bx ON bx.id=db2.brand_id WHERE db2.distributor_id=d.id) AS brand_names
    FROM distributors d LEFT JOIN brands b ON d.brand_id=b.id`;
  let distributors;
  if (scopeSet === null) {
    distributors = db.prepare(base + ' ORDER BY d.id DESC').all();
  } else {
    const vals = brandSetValues(scopeSet);
    const ph = vals.map(() => '?').join(',');
    distributors = db.prepare(`${base} WHERE d.brand_id IN (${ph}) OR EXISTS (SELECT 1 FROM distributor_brands db3 WHERE db3.distributor_id=d.id AND db3.brand_id IN (${ph})) ORDER BY d.id DESC`).all(...vals, ...vals);
  }
  const brandMap = {};
  db.prepare('SELECT distributor_id, brand_id FROM distributor_brands').all().forEach(r => {
    (brandMap[r.distributor_id] = brandMap[r.distributor_id] || []).push(r.brand_id);
  });
  distributors.forEach(d => { d.brand_ids = brandMap[d.id] || (d.brand_id ? [d.brand_id] : []); });
  const brands = scope === null
    ? db.prepare('SELECT id, name FROM brands WHERE enabled=1 ORDER BY id').all()
    : [];
  res.render('distributors', { distributors, brands });
});

// 扫码日志页面（brand 只看自己品牌）
app.get('/logs', requireRole('admin', 'brand', 'brand_staff'), (req, res) => {
  const scopeSet = brandScopeSet(req);
  const logs = scopeSet === null
    ? db.prepare('SELECT * FROM scan_logs ORDER BY scanned_at DESC LIMIT 200').all()
    : db.prepare(`SELECT * FROM scan_logs WHERE brand_id IN (${brandSetValues(scopeSet).map(() => '?').join(',')}) ORDER BY scanned_at DESC LIMIT 200`).all(...brandSetValues(scopeSet));
  res.render('logs', { logs: logs.map(log => ({ ...log, scan_ip: displayScanSource(log.scan_ip) })) });
});

// 删除单条扫码日志（admin/brand；brand 只能删自己品牌的）
app.delete('/api/scan-logs/:id', requireRole('admin', 'brand'), (req, res) => {
  const log = db.prepare('SELECT * FROM scan_logs WHERE id=?').get(req.params.id);
  if (!log) return res.json({ success: false, msg: '记录不存在或已删除' });
  if (!brandInSet(brandScopeSet(req), log.brand_id)) return res.json({ success: false, msg: '没有权限删除该记录' });
  db.prepare('DELETE FROM scan_logs WHERE id=?').run(log.id);
  logOperation(req, 'delete_scan_log', 'scan_log', log.item_code, `删除扫码记录：${log.item_code}（${log.scan_location || '位置未知'}）`);
  res.json({ success: true, msg: '已删除' });
});

// 批量删除扫码日志（ids 数组；brand 只能删自己品牌的）
app.post('/api/scan-logs/batch-delete', requireRole('admin', 'brand'), (req, res) => {
  const scopeSet = brandScopeSet(req);
  const ids = Array.isArray(req.body.ids) ? req.body.ids.map(Number).filter(Number.isInteger) : [];
  if (!ids.length) return res.json({ success: false, msg: '请先勾选要删除的记录' });
  const del = db.transaction(() => {
    let n = 0;
    for (const id of ids) {
      const log = db.prepare('SELECT id, brand_id FROM scan_logs WHERE id=?').get(id);
      if (!log || !brandInSet(scopeSet, log.brand_id)) continue;
      db.prepare('DELETE FROM scan_logs WHERE id=?').run(id);
      n++;
    }
    return n;
  });
  const n = del();
  if (!n) return res.json({ success: false, msg: '没有可删除的记录' });
  logOperation(req, 'batch_delete_scan_logs', 'scan_log', '', `批量删除扫码日志 ${n} 条`);
  res.json({ success: true, msg: `已删除 ${n} 条记录`, deleted: n });
});

// 品牌营销设置页面
app.get('/settings', requireRole('admin'), (req, res) => {
  const settings = readOnlyAccess.publicSettings(db.prepare('SELECT key, value FROM settings').all());
  const campaigns = db.prepare('SELECT * FROM campaigns ORDER BY id DESC').all();
  const prizes = db.prepare(`
    SELECT p.*, c.name as campaign_name
    FROM prize_records p LEFT JOIN campaigns c ON p.campaign_id = c.id
    ORDER BY p.id DESC LIMIT 50
  `).all();
  res.render('settings', { settings, campaigns, prizes });
});

// 标签打印页面
app.get('/print', requireRole('admin', 'brand', 'brand_staff'), (req, res) => {
  const codes = (req.query.codes || '').split(',').map(s => s.trim()).filter(Boolean);
  const type = req.query.type || 'item';
  const product = req.query.product || '';
  // 全局品牌名（兜底，用于未匹配到品牌时显示）
  const defaultBrand = db.prepare("SELECT value FROM settings WHERE key='brand_name'").get()?.value || '';
  // 按每个码的实际品牌归属查询品牌名
  const labelInfo = codes.map(code => {
    let brandName = defaultBrand;
    try {
      if (type === 'box') {
        const row = db.prepare('SELECT COALESCE(br.name, ?) as bn FROM boxes b LEFT JOIN brands br ON br.id=COALESCE(b.brand_id,(SELECT p.brand_id FROM products p WHERE p.id=b.product_id)) WHERE b.box_code=?').get(defaultBrand, code);
        if (row && row.bn) brandName = row.bn;
      } else {
        const row = db.prepare('SELECT COALESCE(br.name, ?) as bn FROM items i LEFT JOIN brands br ON br.id=COALESCE(i.brand_id,(SELECT p.brand_id FROM products p WHERE p.id=i.product_id)) WHERE i.item_code=?').get(defaultBrand, code);
        if (row && row.bn) brandName = row.bn;
      }
    } catch (e) { /* 忽略，用默认品牌名 */ }
    return { code, brand_name: brandName };
  });
  res.render('print', { codes, type, product, labelInfo, brand: defaultBrand });
});

// 码查询页面
app.get('/codes', requireRole('admin', 'brand', 'brand_staff'), (req, res) => {
  res.render('codes');
});

// 下载中心：下载属于独立交付动作，不与码查询、删除或打印混放
app.get('/downloads', requireRole('admin', 'brand', 'brand_staff'), (req, res) => {
  const scopeSet = brandScopeSet(req);
  const products = scopeSet === null
    ? db.prepare(`SELECT p.id,p.name,p.spec,p.brand_id,b.name AS brand_name
        FROM products p LEFT JOIN brands b ON b.id=p.brand_id
        WHERE p.brand_id IS NOT NULL ORDER BY b.name,p.name,p.id`).all()
    : db.prepare(`SELECT p.id,p.name,p.spec,p.brand_id,b.name AS brand_name
        FROM products p LEFT JOIN brands b ON b.id=p.brand_id
        WHERE p.brand_id IN (${brandSetValues(scopeSet).map(() => '?').join(',')}) ORDER BY p.name,p.id`).all(...brandSetValues(scopeSet));
  // 品牌列表：admin 可指定码包归属品牌；brand_staff 固定自身品牌（brands 为空）
  const brands = scopeSet === null
    ? db.prepare('SELECT id, name FROM brands WHERE enabled=1 ORDER BY id').all()
    : [];
  const packages = scopeSet === null
    ? db.prepare(`SELECT cp.*,p.name AS product_name,b.name AS brand_name
        FROM code_packages cp
        LEFT JOIN products p ON p.id=cp.product_id
        LEFT JOIN brands b ON b.id=cp.brand_id
        ORDER BY cp.id DESC LIMIT 100`).all()
    : db.prepare(`SELECT cp.*,p.name AS product_name,b.name AS brand_name
        FROM code_packages cp
        LEFT JOIN products p ON p.id=cp.product_id
        LEFT JOIN brands b ON b.id=cp.brand_id
        WHERE cp.brand_id IN (${brandSetValues(scopeSet).map(() => '?').join(',')}) ORDER BY cp.id DESC LIMIT 100`).all(...brandSetValues(scopeSet));
  res.render('downloads', { products, packages, brands, imageArchiveMaxCodes: IMAGE_ARCHIVE_MAX_CODES });
});

// 品牌方扫码查串货页面
app.get('/brand-check', requireRole('admin', 'brand', 'brand_staff'), (req, res) => {
  res.render('brand-check');
});

// 消费者验证页面（H5，嵌入公众号）：/v 为无码入口（手动输码/摄像头扫码），/v/:code 为二维码直达
app.get(['/v', '/v/:code'], (req, res) => {
  const code = req.params.code || '';
  const settings = readOnlyAccess.publicSettings(db.prepare('SELECT key, value FROM settings').all());
  const brandStats = {
    total_scans: db.prepare('SELECT COUNT(*) as c FROM scan_logs').get().c,
    verified_items: db.prepare('SELECT COUNT(*) as c FROM items WHERE scanned_at IS NOT NULL').get().c
  };
  res.render('verify', { code, settings, brandStats });
});

// ===================== API 路由 =====================

// API 全局登录守卫：除消费者验证、动态二维码外，所有 /api 接口均需登录
app.use('/api', (req, res, next) => {
  const open = req.path === '/qr' || req.path.startsWith('/verify/') || req.path === '/login' || req.path === '/logout';
  const agentApi = req.path.startsWith('/agent/');
  if (open || agentApi || currentUser(req)) return next();
  return res.status(401).json({ success: false, msg: '登录已过期，请重新登录', needLogin: true });
});

// --- 产品管理 ---

const asId = value => Number.isInteger(Number(value)) && Number(value) > 0 ? Number(value) : 0;
const cleanText = (value, max = 500) => String(value || '').trim().slice(0, max);
const localMediaUrl = value => /^\/uploads\/[A-Za-z0-9._-]+$/.test(String(value || ''));
const safeHttpsUrl = value => {
  if (!value) return '';
  try {
    const url = new URL(String(value));
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    const host = url.hostname.toLowerCase();
    if (host === 'localhost' || host.endsWith('.local') || /^(127\.|10\.|192\.168\.|169\.254\.)/.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host)) return null;
    return url.toString();
  } catch { return null; }
};
function normalizedFactoryIds(body = {}) {
  const values = Array.isArray(body.factory_ids)
    ? body.factory_ids
    : (body.factory_id == null || body.factory_id === '' ? [] : [body.factory_id]);
  return [...new Set(values.map(asId).filter(Boolean))];
}
function productFactoryRows(productId) {
  return db.prepare(`SELECT f.id, f.name, f.brand_id
    FROM product_factories pf JOIN factories f ON f.id=pf.factory_id
    WHERE pf.product_id=? ORDER BY pf.created_at, f.id`).all(productId);
}
function withProductFactories(product, providedRows = null) {
  if (!product) return null;
  const rows = providedRows ? [...providedRows] : productFactoryRows(product.id);
  if (!rows.length && product.factory_id) {
    const legacy = db.prepare('SELECT id,name,brand_id FROM factories WHERE id=?').get(product.factory_id);
    if (legacy) rows.push(legacy);
  }
  return {
    ...product,
    factory_ids: rows.map(row => row.id),
    factory_names: rows.map(row => row.name),
    factory_name: rows.length ? rows.map(row => row.name).join('、') : (product.factory_name || '')
  };
}
function withProductsFactories(products) {
  if (!products.length) return [];
  const ids = products.map(product => product.id);
  const placeholders = ids.map(() => '?').join(',');
  const rows = db.prepare(`SELECT pf.product_id,f.id,f.name,f.brand_id
    FROM product_factories pf JOIN factories f ON f.id=pf.factory_id
    WHERE pf.product_id IN (${placeholders}) ORDER BY pf.created_at,f.id`).all(...ids);
  const byProduct = new Map();
  rows.forEach(row => {
    if (!byProduct.has(row.product_id)) byProduct.set(row.product_id, []);
    byProduct.get(row.product_id).push(row);
  });
  return products.map(product => withProductFactories(product, byProduct.get(product.id) || []));
}
// 工厂的品牌集合 = 旧单字段主品牌 ∪ factory_brands（多品牌）。
function factoryBrandSet(factoryId) {
  const ids = new Set();
  const legacy = db.prepare('SELECT brand_id FROM factories WHERE id=?').get(factoryId)?.brand_id;
  if (legacy) ids.add(Number(legacy));
  db.prepare('SELECT brand_id FROM factory_brands WHERE factory_id=?').all(factoryId).forEach(row => ids.add(Number(row.brand_id)));
  return ids;
}
// 工厂装箱端「品牌选项」的口径 = 工厂被授权的品牌 ∩ 账号归属品牌。
// 只看工厂会漏掉账号被授权的其它品牌；只看账号会漏掉工厂没被授权的品牌。
// admin 的 brandScopeSet 为 null（不限制），此时即为工厂支持的全部品牌。
// 返回排序后的 id 数组，供 SQL IN 与前端下拉共用同一份口径。
function factoryPackBrands(req, factoryId) {
  const supported = factoryBrandSet(factoryId);
  const scope = brandScopeSet(req);
  const allowed = scope === null
    ? supported
    : new Set([...supported].filter(id => scope.includes(Number(id))));
  return [...allowed].map(Number).filter(Number.isInteger).sort((a, b) => a - b);
}
// 品牌 id → 名称，保序，丢弃查不到的 id
function brandNamesByIds(ids) {
  if (!ids.length) return [];
  const rows = db.prepare(`SELECT id, name FROM brands WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids);
  const byId = new Map(rows.map(r => [Number(r.id), r.name]));
  return ids.filter(id => byId.has(Number(id))).map(id => ({ id: Number(id), name: byId.get(Number(id)) }));
}
function resolveProductFactories(factoryIds, scopeSet, expectedBrandId = null) {
  if (!factoryIds.length) {
    const fallback = scopeSet === null ? null : (brandSetValues(scopeSet)[0] || null);
    return { rows: [], brandId: expectedBrandId || fallback };
  }
  const placeholders = factoryIds.map(() => '?').join(',');
  const rows = db.prepare(`SELECT id,name,brand_id FROM factories WHERE enabled=1 AND id IN (${placeholders})`).all(...factoryIds);
  if (rows.length !== factoryIds.length) return { error: '所选工厂不存在，请刷新后重试' };
  const sets = rows.map(row => factoryBrandSet(row.id));
  // 归属品牌必须是所有所选工厂共同授权的品牌（集合交集），多品牌工厂因此可被本品牌产品选中。
  let common = new Set(sets[0]);
  sets.slice(1).forEach(set => { common = new Set([...common].filter(id => set.has(id))); });
  const expected = expectedBrandId ? Number(expectedBrandId) : null;
  let brandId = null;
  if (expected && sets.every(set => set.has(expected))) {
    brandId = expected;
  } else if (common.size === 1) {
    brandId = [...common][0];
  } else if (common.size > 1) {
    const legacyIds = [...new Set(rows.map(row => Number(row.brand_id) || 0))];
    if (legacyIds.length === 1 && common.has(legacyIds[0])) brandId = legacyIds[0];
  }
  if (!brandId) return { error: '所选工厂没有共同的授权品牌，请检查工厂的归属品牌' };
  if (!brandInSet(scopeSet, brandId)) return { error: '所选工厂不属于你的品牌' };
  if (expectedBrandId && Number(expectedBrandId) !== brandId) return { error: '产品只能关联所属品牌下的工厂' };
  return { rows, brandId };
}
function replaceProductFactories(productId, factoryIds) {
  db.prepare('DELETE FROM product_factories WHERE product_id=?').run(productId);
  const insert = db.prepare('INSERT INTO product_factories (product_id,factory_id) VALUES (?,?)');
  factoryIds.forEach(factoryId => insert.run(productId, factoryId));
}
function factoryAssignedToProduct(factoryId, productId) {
  if (!factoryId || !productId) return false;
  return !!db.prepare(`SELECT 1 FROM product_factories WHERE product_id=? AND factory_id=?
    UNION ALL SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM product_factories WHERE product_id=?)
    AND (SELECT factory_id FROM products WHERE id=?)=? LIMIT 1`)
    .get(productId, factoryId, productId, productId, factoryId);
}
function factoryReceiptAllowed(req, receipt) {
  const user = currentUser(req);
  if (user?.role !== 'factory') return true;
  const owner = Number(receipt?.receipt_factory_id) || 0;
  if (owner && owner !== Number(user.factory_id)) return false;
  const productId = Number(receipt?.product_id) || 0;
  return !productId || factoryAssignedToProduct(user.factory_id, productId);
}
function operationFactory(req, product, receipt = null) {
  const user = currentUser(req);
  if (user?.role === 'factory') {
    if (!factoryAssignedToProduct(user.factory_id, product.id)) return { error: '该产品未授权给当前工厂' };
    if (receipt?.receipt_factory_id && Number(receipt.receipt_factory_id) !== Number(user.factory_id)) {
      return { error: '该实物码已归属其他工厂，不能继续操作' };
    }
    return { id: Number(user.factory_id) };
  }
  const requested = asId(req.body.operation_factory_id);
  const existing = Number(receipt?.receipt_factory_id) || 0;
  if (existing) {
    if (requested && requested !== existing) return { error: '该实物码已有生产工厂，不能在当前流程中改派' };
    return { id: existing };
  }
  if (!requested) return { error: '请选择本次实际生产工厂' };
  const factory = db.prepare('SELECT id,brand_id FROM factories WHERE id=? AND enabled=1').get(requested);
  if (!factory || !factoryBrandSet(factory.id).has(Number(product.brand_id)) || !factoryAssignedToProduct(factory.id, product.id)) {
    return { error: '所选工厂未启用或未获该产品授权' };
  }
  return { id: factory.id };
}
function activeReceiptsForFactories(productId, factoryIds) {
  if (!factoryIds.length) return { items: 0, boxes: 0 };
  const placeholders = factoryIds.map(() => '?').join(',');
  const items = db.prepare(`SELECT COUNT(*) c FROM items
    WHERE product_id=? AND receipt_factory_id IN (${placeholders}) AND status IN ('scanned','packing') AND boxed_at IS NOT NULL`)
    .get(productId, ...factoryIds).c;
  const boxes = db.prepare(`SELECT COUNT(*) c FROM boxes
    WHERE product_id=? AND receipt_factory_id IN (${placeholders}) AND status IN ('in_stock','packing')
      AND (item_count>0 OR EXISTS (SELECT 1 FROM items i WHERE i.box_id=boxes.id))`)
    .get(productId, ...factoryIds).c;
  return { items, boxes };
}
function scopedProduct(req, id) {
  const product = db.prepare('SELECT * FROM products WHERE id=?').get(asId(id));
  if (!product || !brandInSet(brandScopeSet(req), product.brand_id)) return null;
  const user = currentUser(req);
  if (user?.role === 'factory') {
    if (!factoryAssignedToProduct(user.factory_id, product.id)) return null;
  }
  return withProductFactories(product);
}
function productContent(productId, brandId, batchNo, includeDraft = false) {
  const media = db.prepare(`SELECT id, url, alt_text, sort_order, is_cover FROM product_media
    WHERE product_id=? AND brand_id=? ORDER BY is_cover DESC, sort_order, id`).all(productId, brandId);
  let batch = null;
  let trace = [];
  if (batchNo) {
    batch = db.prepare(`SELECT id, batch_no, production_date, status, published_at FROM product_batches
      WHERE product_id=? AND brand_id=? AND batch_no=? ${includeDraft ? '' : "AND status='published'"}`).get(productId, brandId, batchNo);
    if (batch) trace = db.prepare(`SELECT e.id, e.stage_key, e.title, e.public_location, e.occurred_at, e.detail, e.evidence_url
      FROM batch_trace_entries e WHERE e.batch_id=? AND e.brand_id=? ${includeDraft ? '' : 'AND e.published=1'}
      AND NOT EXISTS (SELECT 1 FROM batch_trace_entries newer WHERE newer.revision_of=e.id)
      ORDER BY e.occurred_at, e.id`).all(batch.id, brandId);
  }
  const now = new Date().toISOString();
  const marketing = db.prepare(`SELECT image_url, title, description, target_url, starts_at, ends_at
    FROM product_marketing WHERE product_id=? AND brand_id=? AND enabled=1 AND review_status='approved'
      AND (starts_at='' OR starts_at<=?) AND (ends_at='' OR ends_at>=?)`).get(productId, brandId, now, now) || null;
  return { media, batch, trace, marketing };
}
const publicContentFields = content => ({
  product_media: content.media,
  trace_timeline: content.trace.map(entry => ({ ...entry, description: entry.detail })),
  promotion: content.marketing
});

// 新增产品（admin 可指定工厂；brand 只能建自己品牌的产品，可选工厂限本品牌）
app.post('/api/products', requireRole('admin', 'brand', 'brand_staff'), optionalBrowserIdempotency, (req, res) => {
  const { name, spec, batch_no } = req.body;
  const box_size = parseInt(req.body.box_size) || 0;
  const scope = brandScope(req);
  const scopeSet = brandScopeSet(req);
  const factoryIds = normalizedFactoryIds(req.body);
  let factory_id = factoryIds[0] || null;
  let brand_id = null;
  if (!name) return res.json({ success: false, msg: '产品名称不能为空' });
  const requested = parseInt(req.body.brand_id) || null;
  const requestedBrandId = scopeSet === null ? requested : (brandInSet(scopeSet, requested) ? requested : (brandSetValues(scopeSet)[0] ?? null));
  const resolvedFactories = resolveProductFactories(factoryIds, scopeSet, requestedBrandId);
  if (resolvedFactories.error) return res.status(400).json({ success: false, code: 'PRODUCT_FACTORY_INVALID', msg: resolvedFactories.error });
  brand_id = resolvedFactories.brandId;
  if (scopeSet !== null) brand_id = brandInSet(scopeSet, resolvedFactories.brandId) ? resolvedFactories.brandId : (brandSetValues(scopeSet)[0] ?? null);
  // 平台管理员可显式指定品牌（未指定工厂，或工厂本身未归属品牌时生效）
  if (scopeSet === null && (!factory_id || !brand_id) && req.body.brand_id) brand_id = parseInt(req.body.brand_id) || null;
  if (!brand_id) return res.status(400).json({ success: false, code: 'PRODUCT_BRAND_REQUIRED', msg: '请选择「归属品牌」或「归属工厂」后再保存' });
  if (!db.prepare('SELECT 1 FROM brands WHERE id=? AND enabled=1').get(brand_id)) {
    return res.status(400).json({ success: false, code: 'PRODUCT_BRAND_INVALID', msg: '所选品牌不存在或已停用' });
  }
  const description = cleanText(req.body.description, 2000);
  const ena13 = cleanText(req.body.ena13, 32);
  if (factoryIds.length && Number(brand_id) !== Number(resolvedFactories.brandId)) {
    return res.status(409).json({ success: false, code: 'PRODUCT_FACTORY_BRAND_CONFLICT', msg: '归属品牌与所选工厂不一致' });
  }
  const result = db.transaction(() => {
    const created = db.prepare('INSERT INTO products (name, spec, batch_no, box_size, factory_id, brand_id, description, ena13) VALUES (?,?,?,?,?,?,?,?)')
      .run(name, spec || '', batch_no || '', box_size, factory_id, brand_id, description, ena13);
    replaceProductFactories(created.lastInsertRowid, factoryIds);
    return created;
  })();
  logOperation(req, 'create_product', 'product', result.lastInsertRowid, `创建产品「${cleanText(name, 120)}」`);
  res.json({ success: true, id: result.lastInsertRowid, version: 1, factory_ids: factoryIds });
});

// 修改产品（含箱规）
app.put('/api/products/:id', requireRole('admin', 'brand', 'brand_staff'), (req, res) => {
  const { id } = req.params;
  const { name, spec, batch_no } = req.body;
  const box_size = parseInt(req.body.box_size) || 0;
  if (!name) return res.json({ success: false, msg: '产品名称不能为空' });
  const product = db.prepare('SELECT * FROM products WHERE id=?').get(id);
  if (!product || !brandInSet(brandScopeSet(req), product.brand_id)) return res.status(404).json({ success: false, msg: '产品不存在' });
  const scopeSet = brandScopeSet(req);
  const requestedBrandId = parseInt(req.body.brand_id) || product.brand_id;
  const changingBrand = requestedBrandId !== Number(product.brand_id);
  if (!brandInSet(scopeSet, requestedBrandId) || !db.prepare('SELECT 1 FROM brands WHERE id=? AND enabled=1').get(requestedBrandId)) {
    return res.status(400).json({ success: false, code: 'PRODUCT_BRAND_INVALID', msg: '所选品牌不存在、已停用或当前账号无权管理' });
  }
  if (changingBrand) {
    const references = db.prepare(`SELECT
      (SELECT COUNT(*) FROM boxes WHERE product_id=?) +
      (SELECT COUNT(*) FROM items WHERE product_id=?) +
      (SELECT COUNT(*) FROM pack_records WHERE product_id=?) +
      (SELECT COUNT(*) FROM code_packages WHERE product_id=?) AS count`).get(id, id, id, id).count;
    if (references > 0) {
      return res.status(409).json({ success: false, code: 'PRODUCT_BRAND_HAS_CODES', msg: `该产品已有 ${references} 条箱码、子码或生产记录，不能直接改归属品牌，以免历史扫码与库存归错。请新建关谷庄产品并在确认无关联库存后切换。` });
    }
    const duplicateBatch = db.prepare(`SELECT COUNT(*) count FROM product_batches old
      JOIN product_batches target ON target.product_id=old.product_id AND target.brand_id=? AND target.batch_no=old.batch_no
      WHERE old.product_id=? AND old.brand_id=?`).get(requestedBrandId, id, product.brand_id).count;
    if (duplicateBatch > 0) return res.status(409).json({ success: false, code: 'PRODUCT_BRAND_BATCH_CONFLICT', msg: '目标品牌已有同名批次，无法安全切换该产品' });
  }
  const factoryIds = normalizedFactoryIds(req.body);
  const factoryId = factoryIds[0] || null;
  const resolvedFactories = resolveProductFactories(factoryIds, scopeSet, requestedBrandId);
  if (resolvedFactories.error) return res.status(400).json({ success: false, code: 'PRODUCT_FACTORY_INVALID', msg: resolvedFactories.error });
  const currentFactoryIds = withProductFactories(product).factory_ids;
  const removedFactoryIds = currentFactoryIds.filter(factoryId => !factoryIds.includes(factoryId));
  const activeReceipts = activeReceiptsForFactories(product.id, removedFactoryIds);
  if (activeReceipts.items || activeReceipts.boxes) {
    return res.status(409).json({
      success: false,
      code: 'PRODUCT_FACTORY_HAS_ACTIVE_STOCK',
      msg: `不能移除仍有在库实物的工厂：涉及 ${activeReceipts.boxes} 个箱码、${activeReceipts.items} 个子码。请先完成发货、取消入库或办理工厂交接。`
    });
  }
  const expectedVersion = req.body.version == null ? product.version : Number(req.body.version);
  const result = db.transaction(() => {
    const updated = db.prepare(`UPDATE products SET name=?, spec=?, batch_no=?, box_size=?, factory_id=?, brand_id=?, description=?, ena13=?, version=version+1
      WHERE id=? AND version=?`).run(name, spec || '', batch_no || '', box_size, factoryId, requestedBrandId, cleanText(req.body.description, 2000), cleanText(req.body.ena13, 32), id, expectedVersion);
    if (updated.changes) {
      replaceProductFactories(product.id, factoryIds);
      if (changingBrand) {
        for (const table of ['product_media', 'product_trace_templates', 'product_batches', 'product_reports']) {
          db.prepare(`UPDATE ${table} SET brand_id=? WHERE product_id=? AND brand_id=?`).run(requestedBrandId, id, product.brand_id);
        }
        db.prepare(`UPDATE batch_trace_entries SET brand_id=? WHERE brand_id=? AND batch_id IN
          (SELECT id FROM product_batches WHERE product_id=? AND brand_id=?)`).run(requestedBrandId, product.brand_id, id, requestedBrandId);
        db.prepare(`UPDATE product_marketing SET brand_id=?, review_status='pending', reviewed_by=NULL, reviewed_at=NULL, version=version+1
          WHERE product_id=? AND brand_id=?`).run(requestedBrandId, id, product.brand_id);
      }
    }
    return updated;
  })();
  if (!result.changes) return res.status(409).json({ success: false, code: 'VERSION_CONFLICT', msg: '产品已被其他用户修改，请刷新后重试' });
  logOperation(req, 'update_product', 'product', id, `更新产品「${cleanText(name, 120)}」`);
  res.json({ success: true, version: expectedVersion + 1, factory_ids: factoryIds, brand_id: requestedBrandId, brand_changed: changingBrand });
});

// 删除产品（admin/brand；该产品下没有任何未删除的箱码/子码时才能删除）
app.delete('/api/products/:id', requireRole('admin', 'brand'), (req, res) => {
  const { id } = req.params;
  const pid = parseInt(id);
  if (!pid) return res.json({ success: false, msg: '无效的产品 ID' });
  const product = db.prepare('SELECT * FROM products WHERE id=?').get(pid);
  if (!product) return res.json({ success: false, msg: '产品不存在' });
  if (!brandInSet(brandScopeSet(req), product.brand_id)) return res.json({ success: false, msg: '没有权限操作该产品' });
  const boxCount = db.prepare("SELECT COUNT(*) c FROM boxes WHERE product_id=?").get(pid).c;
  if (boxCount > 0) return res.json({ success: false, msg: '该产品下还有 ' + boxCount + ' 个箱码，请先删除/作废所有码' });
  const itemCount = db.prepare("SELECT COUNT(*) c FROM items WHERE product_id=?").get(pid).c;
  if (itemCount > 0) return res.json({ success: false, msg: '该产品下还有 ' + itemCount + ' 个子码，请先删除/作废所有码' });
  db.prepare('DELETE FROM products WHERE id=?').run(pid);
  logOperation(req, 'delete_product', 'product', pid, '产品「' + product.name + '」已物理删除');
  res.json({ success: true, msg: '产品已删除' });
});

// 获取产品列表（工厂角色只看自己工厂；品牌管理员只看自己品牌）
app.get('/api/products', requireRole('admin', 'factory', 'brand', 'brand_staff'), (req, res) => {
  let sql = 'SELECT * FROM products WHERE 1=1';
  const params = [];
  const user = currentUser(req);
  const role = user.role;
  let packBrands = null;
  if (role === 'factory') {
    // 多品牌：工厂账号可能被授权多个品牌，账号也可能归属多个品牌。
    packBrands = user.factory_id ? factoryPackBrands(req, user.factory_id) : [];
    if (!user.factory_id || !packBrands.length) sql += ' AND 1=0';
    else {
      sql += ` AND brand_id IN (${packBrands.map(() => '?').join(',')}) AND (
        EXISTS (SELECT 1 FROM product_factories pf WHERE pf.product_id=products.id AND pf.factory_id=?)
        OR (NOT EXISTS (SELECT 1 FROM product_factories pf0 WHERE pf0.product_id=products.id) AND factory_id=?)
      )`;
      params.push(...packBrands, user.factory_id, user.factory_id);
    }
  } else if (role === 'admin') {
    // 平台管理员的装箱端同样要「先选品牌」：品牌选项 = 账号归属品牌。
    // 账号一个归属品牌都没有时（全局超管）退回全部启用品牌，否则它无从选择、装箱页不可用。
    // 注意：这里只决定**品牌选项**；admin 的产品列表仍是全局的（admin 各页一律不按品牌收窄），
    // 产品按下拉选中的品牌在前端过滤。
    const owned = userOwnerBrandIds(user);
    packBrands = owned.length ? owned : enabledBrandIds();
  } else if (['brand', 'brand_staff'].includes(role)) {
    const ownerSet = brandScopeSet(req);
    packBrands = ownerSet === null ? enabledBrandIds() : brandSetValues(ownerSet);
    if (ownerSet !== null) {
      sql += brandSqlFilter(ownerSet);
      params.push(...brandSetValues(ownerSet));
    }
  }
  sql += ' ORDER BY id DESC';
  const products = withProductsFactories(db.prepare(sql).all(...params));
  // 工厂装箱端：把「品牌选项」一并返回。选项口径 = 工厂授权 ∩ 账号归属，
  // r24 起**不**按"该品牌下有没有产品"过滤（按用户要求与账号归属保持一致）；
  // 某品牌本厂暂时无产品时，用 brandPackable / brandTotal 把原因说清楚。
  const payload = { success: true, products };
  if (packBrands !== null) {
    // 品牌选项 = 工厂授权 ∩ 账号归属，**不**再按"该品牌下有没有产品"过滤。
    // 运行期实测：工厂12 只有"宠超人"有产品，若按有产品过滤，账号即便归属 3 个品牌
    // 前端也只会拿到 1 个 → 品牌下拉被隐藏 → 用户看到的就是"还是一个品牌"。
    payload.brands = brandNamesByIds(packBrands);
    // 品牌选项的措辞随角色不同：工厂是「本厂暂无可装产品」，其他人（含平台管理员）是「暂无产品」。
    // 不区分的话，管理员会看到「本厂」这种不存在的概念。
    payload.brandOptionScope = role === 'factory' ? 'factory' : 'owner';
    // 诊断口径：每个品牌「本厂可装的产品数」与「该品牌产品总数」。
    // 两者不一致时必须能说清是"该品牌没产品"还是"有产品但没绑定本工厂"，
    // 否则工人只会看到一个空下拉，误判成功能坏了。
    const brandPackable = {};
    const brandTotals = {};
    packBrands.forEach(bid => { brandPackable[bid] = 0; brandTotals[bid] = 0; });
    products.forEach(p => {
      const bid = Number(p.brand_id) || 0;
      if (Object.hasOwn(brandPackable, bid)) brandPackable[bid] += 1;
    });
    if (packBrands.length) {
      const ph = packBrands.map(() => '?').join(',');
      db.prepare(`SELECT brand_id, COUNT(*) AS n FROM products WHERE brand_id IN (${ph}) GROUP BY brand_id`)
        .all(...packBrands)
        .forEach(row => { brandTotals[Number(row.brand_id)] = Number(row.n) || 0; });
    }
    payload.brandPackable = brandPackable;
    payload.brandTotal = brandTotals;
  }
  // 工厂账号由登录身份锁定工厂，不显示或发送工厂选择；管理员才需要代选。
  if (role === 'factory') {
    payload.factoryLocked = true;
  } else {
    if (packBrands && packBrands.length) {
      const ph = packBrands.map(() => '?').join(',');
      payload.factories = db.prepare(
        `SELECT DISTINCT f.id, f.name FROM factories f
         WHERE f.enabled=1 AND EXISTS (
           SELECT 1 FROM factory_brands fb WHERE fb.factory_id=f.id AND fb.brand_id IN (${ph})
         ) ORDER BY f.name`
      ).all(...packBrands).map(factory => ({ ...factory, brand_ids: [...factoryBrandSet(factory.id)] }));
    } else {
      payload.factories = db.prepare('SELECT id, name FROM factories WHERE enabled=1 ORDER BY name').all()
        .map(factory => ({ ...factory, brand_ids: [...factoryBrandSet(factory.id)] }));
    }
  }
  res.json(payload);
});

// 产品内容详情（草稿仅对所属租户后台可见）
app.get('/api/products/:id/content', requireRole('admin', 'brand', 'brand_staff', 'factory'), (req, res) => {
  const product = scopedProduct(req, req.params.id);
  if (!product) return res.status(404).json({ success: false, msg: '产品不存在' });
  product.brand_locked = !!db.prepare(`SELECT 1 FROM boxes WHERE product_id=? UNION ALL
    SELECT 1 FROM items WHERE product_id=? UNION ALL SELECT 1 FROM pack_records WHERE product_id=?
    UNION ALL SELECT 1 FROM code_packages WHERE product_id=? LIMIT 1`).get(product.id, product.id, product.id, product.id);
  const templates = db.prepare(`SELECT id, stage_key, title, public_label, content, image_url, sort_order, enabled FROM product_trace_templates
    WHERE product_id=? AND brand_id=? ORDER BY sort_order,id`).all(product.id, product.brand_id);
  const batches = db.prepare(`SELECT id, batch_no, production_date, status, published_at, version, created_at, updated_at
    FROM product_batches WHERE product_id=? AND brand_id=? ORDER BY id DESC`).all(product.id, product.brand_id);
  const marketing = db.prepare('SELECT * FROM product_marketing WHERE product_id=? AND brand_id=?').get(product.id, product.brand_id) || null;
  res.json({ success: true, product, templates, batches, marketing, ...productContent(product.id, product.brand_id, '', true) });
});

function replaceProductMedia(req, res) {
  const product = scopedProduct(req, req.params.id || req.body.product_id);
  if (!product) return res.status(404).json({ success: false, msg: '产品不存在' });
  const media = Array.isArray(req.body.media) ? req.body.media : [];
  if (media.length > 6 || media.some(row => !localMediaUrl(row?.url))) return res.status(400).json({ success: false, code: 'INVALID_PRODUCT_MEDIA', msg: '产品图片必须来自本系统且不能超过6张' });
  const normalized = media.map((row, index) => ({ url: row.url, alt: cleanText(row.alt_text, 160), cover: row.is_cover ? 1 : 0, order: index }));
  if (normalized.filter(row => row.cover).length > 1) return res.status(400).json({ success: false, code: 'MULTIPLE_COVERS', msg: '只能设置一张封面' });
  if (normalized.length && !normalized.some(row => row.cover)) normalized[0].cover = 1;
  db.transaction(() => {
    db.prepare('DELETE FROM product_media WHERE product_id=? AND brand_id=?').run(product.id, product.brand_id);
    const insert = db.prepare(`INSERT INTO product_media (brand_id,product_id,url,alt_text,sort_order,is_cover,created_by) VALUES (?,?,?,?,?,?,?)`);
    normalized.forEach(row => insert.run(product.brand_id, product.id, row.url, row.alt, row.order, row.cover, currentUser(req).id || null));
  })();
  logOperation(req, 'replace_product_media', 'product', product.id, `更新产品图片，共 ${normalized.length} 张`);
  res.json({ success: true, media: productContent(product.id, product.brand_id, '', true).media });
}
app.put('/api/products/:id/media', requireRole('admin', 'brand', 'brand_staff'), replaceProductMedia);

function replaceTraceTemplate(req, res) {
  const product = scopedProduct(req, req.params.id || req.body.product_id);
  if (!product) return res.status(404).json({ success: false, msg: '产品不存在' });
  const stages = Array.isArray(req.body.stages) ? req.body.stages : [];
  if (stages.length > 30) return res.status(400).json({ success: false, msg: '溯源阶段不能超过30项' });
  const rows = stages.map((stage, index) => ({ key: cleanText(stage.stage_key, 40), title: cleanText(stage.title, 100), label: cleanText(stage.public_label, 100), content: cleanText(stage.content, 5000), image_url: cleanText(stage.image_url, 2048), enabled: stage.enabled === false ? 0 : 1, order: index }));
  if (rows.some(row => !/^[a-z][a-z0-9_-]{1,39}$/.test(row.key) || !row.title) || new Set(rows.map(row => row.key)).size !== rows.length) return res.status(400).json({ success: false, code: 'INVALID_TRACE_TEMPLATE', msg: '阶段标识或标题无效、重复' });
  db.transaction(() => {
    db.prepare('DELETE FROM product_trace_templates WHERE product_id=? AND brand_id=? AND id NOT IN (SELECT template_id FROM batch_trace_entries WHERE template_id IS NOT NULL)').run(product.id, product.brand_id);
    const upsert = db.prepare(`INSERT INTO product_trace_templates (brand_id,product_id,stage_key,title,public_label,content,image_url,sort_order,enabled)
      VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(product_id,stage_key) DO UPDATE SET title=excluded.title,public_label=excluded.public_label,content=excluded.content,image_url=excluded.image_url,sort_order=excluded.sort_order,enabled=excluded.enabled`);
    rows.forEach(row => upsert.run(product.brand_id, product.id, row.key, row.title, row.label, row.content, row.image_url, row.order, row.enabled));
    if (rows.length) db.prepare(`UPDATE product_trace_templates SET enabled=0 WHERE product_id=? AND brand_id=? AND stage_key NOT IN (${rows.map(() => '?').join(',')})`).run(product.id, product.brand_id, ...rows.map(row => row.key));
    else db.prepare('UPDATE product_trace_templates SET enabled=0 WHERE product_id=? AND brand_id=?').run(product.id, product.brand_id);
  })();
  logOperation(req, 'replace_trace_template', 'product', product.id, `更新溯源模板，共 ${rows.length} 个阶段`);
  res.json({ success: true });
}
app.put('/api/products/:id/trace-template', requireRole('admin', 'brand', 'brand_staff'), replaceTraceTemplate);

function createProductBatch(req, res) {
  const product = scopedProduct(req, req.params.id || req.body.product_id);
  if (!product) return res.status(404).json({ success: false, msg: '产品不存在' });
  const batchNo = cleanText(req.body.batch_no, 80);
  if (!batchNo) return res.status(400).json({ success: false, msg: '批次号不能为空' });
  try {
    const result = db.prepare(`INSERT INTO product_batches (brand_id,product_id,batch_no,production_date,created_by) VALUES (?,?,?,?,?)`)
      .run(product.brand_id, product.id, batchNo, cleanText(req.body.production_date, 20), currentUser(req).id || null);
    logOperation(req, 'create_product_batch', 'product_batch', result.lastInsertRowid, `创建批次「${batchNo}」`);
    res.status(201).json({ success: true, id: result.lastInsertRowid, version: 1 });
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') return res.status(409).json({ success: false, code: 'BATCH_EXISTS', msg: '该批次已存在' });
    throw error;
  }
}
app.post('/api/products/:id/batches', requireRole('admin', 'brand', 'brand_staff'), createProductBatch);

function scopedBatch(req, id) {
  const row = db.prepare(`SELECT pb.*,p.name product_name FROM product_batches pb JOIN products p ON p.id=pb.product_id WHERE pb.id=?`).get(asId(id));
  if (!row || !brandInSet(brandScopeSet(req), row.brand_id)) return null;
  const user = currentUser(req);
  if (user?.role === 'factory' && !factoryAssignedToProduct(user.factory_id, row.product_id)) return null;
  return row;
}
function appendTraceEntry(req, res) {
  const batch = scopedBatch(req, req.params.batchId || req.body.batch_id);
  if (!batch) return res.status(404).json({ success: false, msg: '批次不存在' });
  const stageKey = cleanText(req.body.stage_key, 40), title = cleanText(req.body.title, 100), occurredAt = cleanText(req.body.occurred_at, 40);
  if (!stageKey || !title || !occurredAt || Number.isNaN(Date.parse(occurredAt))) return res.status(400).json({ success: false, msg: '阶段、标题和有效发生时间不能为空' });
  const evidence = cleanText(req.body.evidence_url, 300);
  if (evidence && !localMediaUrl(evidence)) return res.status(400).json({ success: false, msg: '凭证图片必须来自本系统上传' });
  const template = db.prepare('SELECT id FROM product_trace_templates WHERE product_id=? AND brand_id=? AND stage_key=?').get(batch.product_id, batch.brand_id, stageKey);
  const revisionOf = asId(req.body.revision_of) || null;
  if (revisionOf && !db.prepare('SELECT id FROM batch_trace_entries WHERE id=? AND batch_id=? AND brand_id=?').get(revisionOf, batch.id, batch.brand_id)) return res.status(404).json({ success: false, msg: '被修订的履历不存在' });
  const result = db.prepare(`INSERT INTO batch_trace_entries (brand_id,batch_id,template_id,stage_key,title,public_location,occurred_at,detail,evidence_url,revision_of,published,created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(batch.brand_id,batch.id,template?.id||null,stageKey,title,cleanText(req.body.public_location,120),new Date(occurredAt).toISOString(),cleanText(req.body.detail,2000),evidence,revisionOf,req.body.published?1:0,currentUser(req).id||null);
  logOperation(req, revisionOf ? 'revise_trace_entry' : 'append_trace_entry', 'batch_trace_entry', result.lastInsertRowid, `批次「${batch.batch_no}」新增履历「${title}」`);
  res.status(201).json({ success: true, id: result.lastInsertRowid });
}
app.post('/api/batches/:batchId/trace', requireRole('admin', 'brand', 'brand_staff'), appendTraceEntry);
app.get('/api/batches/:batchId/trace', requireRole('admin', 'brand', 'brand_staff', 'factory'), (req,res) => {
  const batch=scopedBatch(req,req.params.batchId); if(!batch) return res.status(404).json({success:false,msg:'批次不存在'});
  res.json({success:true,batch,trace:db.prepare('SELECT * FROM batch_trace_entries WHERE batch_id=? AND brand_id=? ORDER BY occurred_at,id').all(batch.id,batch.brand_id)});
});
function publishBatch(req, res) {
  const batch = scopedBatch(req, req.params.batchId || req.body.batch_id);
  if (!batch) return res.status(404).json({ success: false, msg: '批次不存在' });
  const expected = req.body.version == null ? batch.version : Number(req.body.version);
  const result = db.prepare(`UPDATE product_batches SET status='published',published_at=datetime('now','localtime'),version=version+1,updated_at=datetime('now','localtime') WHERE id=? AND version=?`).run(batch.id, expected);
  if (!result.changes) return res.status(409).json({ success:false,code:'VERSION_CONFLICT',msg:'批次已被修改' });
  db.prepare('UPDATE batch_trace_entries SET published=1 WHERE batch_id=? AND brand_id=?').run(batch.id,batch.brand_id);
  logOperation(req,'publish_product_batch','product_batch',batch.id,`发布批次「${batch.batch_no}」`);
  res.json({success:true,version:expected+1});
}
app.put('/api/batches/:batchId/publish', requireRole('admin','brand'), publishBatch);

function saveMarketing(req,res) {
  const product=scopedProduct(req,req.params.id||req.body.product_id); if(!product) return res.status(404).json({success:false,msg:'产品不存在'});
  const image=cleanText(req.body.image_url,300), target=safeHttpsUrl(req.body.target_url);
  if((image&&!localMediaUrl(image))||target===null) return res.status(400).json({success:false,code:'INVALID_MARKETING_CONTENT',msg:'广告图片或HTTPS链接无效'});
  db.prepare(`INSERT INTO product_marketing (product_id,brand_id,image_url,title,description,target_url,starts_at,ends_at,enabled,review_status)
    VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(product_id) DO UPDATE SET image_url=excluded.image_url,title=excluded.title,description=excluded.description,target_url=excluded.target_url,starts_at=excluded.starts_at,ends_at=excluded.ends_at,enabled=excluded.enabled,review_status='pending',version=product_marketing.version+1,updated_at=datetime('now','localtime')`)
    .run(product.id,product.brand_id,image,cleanText(req.body.title,120),cleanText(req.body.description,1000),target||'',cleanText(req.body.starts_at,40),cleanText(req.body.ends_at,40),req.body.enabled?1:0,'pending');
  logOperation(req,'save_product_marketing','product',product.id,'保存产品营销内容，等待审核'); res.json({success:true,review_status:'pending'});
}
app.put('/api/products/:id/marketing',requireRole('admin','brand','brand_staff'),saveMarketing);
app.put('/api/products/:id/marketing/review',requireRole('admin','brand'),(req,res)=>{
  const product=scopedProduct(req,req.params.id); if(!product)return res.status(404).json({success:false,msg:'产品不存在'});
  const status=req.body.status; if(!['approved','rejected'].includes(status))return res.status(400).json({success:false,msg:'审核状态无效'});
  const result=db.prepare(`UPDATE product_marketing SET review_status=?,reviewed_by=?,reviewed_at=datetime('now','localtime'),version=version+1 WHERE product_id=? AND brand_id=?`).run(status,currentUser(req).id||null,product.id,product.brand_id);
  if(!result.changes)return res.status(404).json({success:false,msg:'营销内容不存在'}); logOperation(req,'review_product_marketing','product',product.id,`营销内容审核：${status}`); res.json({success:true});
});

// Agent 使用同一租户/角色校验与业务处理器；所有写命令必须带幂等键。
app.put('/api/agent/products/:id/media',requireAgentToken,requireAgentRole('admin','brand','brand_staff'),requireAgentIdempotency,replaceProductMedia);
app.put('/api/agent/products/:id/trace-template',requireAgentToken,requireAgentRole('admin','brand','brand_staff'),requireAgentIdempotency,replaceTraceTemplate);
app.post('/api/agent/products/:id/batches',requireAgentToken,requireAgentRole('admin','brand','brand_staff'),requireAgentIdempotency,createProductBatch);
app.post('/api/agent/batches/:batchId/trace',requireAgentToken,requireAgentRole('admin','brand','brand_staff'),requireAgentIdempotency,appendTraceEntry);
app.put('/api/agent/products/:id/marketing',requireAgentToken,requireAgentRole('admin','brand','brand_staff'),requireAgentIdempotency,saveMarketing);

// --- 码生成 ---

// 生成码函数
const genCode = (prefix) => {
  const ts = Date.now().toString(36).toUpperCase();
  const rand = Math.random().toString(36).substring(2, 8).toUpperCase();
  return `${prefix}${ts}${rand}`;
};

// 扫码枪可能扫出完整URL（http://host/v/BMSSR...）或纯码值，统一提取码值
const extractCode = (input) => {
  if (!input) return input;
  const s = String(input).trim();
  const m = s.match(/\/v\/([A-Z0-9]+)/i);
  if (m) return m[1];
  return s;
};

// 二维码只使用已通过应用级白名单校验的访问地址。
const getBaseUrl = (req) => `${req.protocol}://${req.get('host')}`;
const ensureQrOutputDirectory = () => fs.mkdirSync(path.join(__dirname, 'public', 'qr'), { recursive: true, mode: 0o750 });

// 大批量 TXT 码包不预生成图片，后台首次查看某个码时再按需生成二维码。
// 仅为数据库中真实存在的码生成，避免把本服务变成任意文本二维码生成器。
app.get('/qr/:code.png', wrap(async (req, res) => {
  const code = extractCode(req.params.code);
  if (!/^[A-Z0-9]+$/i.test(String(code || ''))) return res.status(404).end();
  const exists = db.prepare('SELECT 1 FROM boxes WHERE box_code=? UNION ALL SELECT 1 FROM items WHERE item_code=? LIMIT 1').get(code, code);
  if (!exists) return res.status(404).end();
  ensureQrOutputDirectory();
  const buffer = await getQrBuffer(code, String(code).startsWith('B') ? 300 : 200, getBaseUrl(req));
  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Cache-Control', 'public, max-age=3600, must-revalidate');
  res.send(buffer);
}));

function requireRegisteredBatch(product, batchNo, res) {
  const normalized = String(batchNo || '').trim();
  if (!normalized) {
    res.status(400).json({ success: false, code: 'BATCH_REQUIRED', msg: '选择产品后必须填写已登记批次号' });
    return null;
  }
  const batch = db.prepare(`SELECT id,batch_no,status FROM product_batches
    WHERE product_id=? AND brand_id=? AND batch_no=?`).get(product.id, product.brand_id, normalized);
  if (!batch) {
    res.status(404).json({ success: false, code: 'BATCH_NOT_FOUND', msg: '该产品批次不存在，请先创建批次' });
    return null;
  }
  return batch;
}

// 单独生成箱码（父码，暂不绑定子码）
// product_id 可选：不选产品=空白箱码，装箱时扫箱码再选择产品；选了产品则码自带产品信息
const generateBoxes = wrap(async (req, res) => {
  ensureQrOutputDirectory();
  const { product_id, batch_no, box_count } = req.body;
  const bCount = Math.min(parseInt(box_count) || 1, 1000);
  const scopeSet = brandScopeSet(req);

  let pid = null, brandId = null;
  if (product_id) {
    const product = db.prepare('SELECT * FROM products WHERE id=?').get(product_id);
    if (!product) return res.json({ success: false, msg: '产品不存在' });
    if (!brandInSet(scopeSet, product.brand_id)) return res.json({ success: false, msg: '该产品不属于你的品牌' });
    if (!requireRegisteredBatch(product, batch_no, res)) return;
    pid = product.id;
    brandId = product.brand_id;
  } else {
    if (scopeSet !== null) {
      // 品牌方账号：空白码归自己品牌
      brandId = brandSetValues(scopeSet)[0];
    } else {
      // 平台管理员（总管理员）：必须显式指定归属品牌
      const bid = parseInt(req.body.brand_id);
      if (!bid) return res.json({ success: false, msg: '请选择这批码的归属品牌' });
      brandId = bid;
    }
  }

  const insertBox = db.prepare('INSERT INTO boxes (box_code, product_id, brand_id, batch_no, item_count) VALUES (?,?,?,?,0)');
  const generated = [];
  const baseUrl = getBaseUrl(req);

  for (let b = 0; b < bCount; b++) {
    let boxCode = genCode('B');
    // 防重
    while (db.prepare('SELECT 1 FROM boxes WHERE box_code=?').get(boxCode)) {
      boxCode = genCode('B');
    }
    const boxResult = insertBox.run(boxCode, pid, brandId, String(batch_no || '').trim());
    const boxUrl = `${baseUrl}/v/${boxCode}`;
    const boxQrPath = path.join(__dirname, 'public', 'qr', `${boxCode}.png`);
    await QRCode.toFile(boxQrPath, boxUrl, { width: 300, margin: 1 });
    generated.push({ id: Number(boxResult.lastInsertRowid), box_code: boxCode, qr_url: `/qr/${boxCode}.png` });
  }

  logOperation(req, 'generate_boxes', 'box', generated[0]?.box_code || '', `生成箱码 ${generated.length} 个${req.agentUser ? '（Agent API）' : ''}`);
  res.json({ success: true, generated, count: generated.length, requestId: req.requestId });
});
app.post('/api/codes/generate/boxes', requireRole('admin', 'brand_staff'), requireBrowserIdempotency, generateBoxes);
app.post('/api/agent/codes/boxes', requireAgentToken, requireAgentRole('admin', 'brand_staff'), requireAgentIdempotency, generateBoxes);

// 单独生成子码（未绑定箱码）
// product_id 可选：不选产品=空白子码，装箱绑定箱码时自动跟随箱码产品
const generateItems = wrap(async (req, res) => {
  ensureQrOutputDirectory();
  const { product_id, batch_no, item_count } = req.body;
  const iCount = Math.min(parseInt(item_count) || 1, 5000);
  const scopeSet = brandScopeSet(req);

  let pid = null, brandId = null;
  if (product_id) {
    const product = db.prepare('SELECT * FROM products WHERE id=?').get(product_id);
    if (!product) return res.json({ success: false, msg: '产品不存在' });
    if (!brandInSet(scopeSet, product.brand_id)) return res.json({ success: false, msg: '该产品不属于你的品牌' });
    if (!requireRegisteredBatch(product, batch_no, res)) return;
    pid = product.id;
    brandId = product.brand_id;
  } else {
    if (scopeSet !== null) {
      brandId = brandSetValues(scopeSet)[0];
    } else {
      const bid = parseInt(req.body.brand_id);
      if (!bid) return res.json({ success: false, msg: '请选择这批码的归属品牌' });
      brandId = bid;
    }
  }

  const insertItem = db.prepare('INSERT INTO items (item_code, box_id, product_id, brand_id, batch_no) VALUES (?,NULL,?,?,?)');
  const generated = [];
  const baseUrl = getBaseUrl(req);

  for (let i = 0; i < iCount; i++) {
    let itemCode = genCode('S');
    while (db.prepare('SELECT 1 FROM items WHERE item_code=?').get(itemCode)) {
      itemCode = genCode('S');
    }
    const itemResult = insertItem.run(itemCode, pid, brandId, String(batch_no || '').trim());
    const itemUrl = `${baseUrl}/v/${itemCode}`;
    const itemQrPath = path.join(__dirname, 'public', 'qr', `${itemCode}.png`);
    await QRCode.toFile(itemQrPath, itemUrl, { width: 200, margin: 1 });
    generated.push({ id: Number(itemResult.lastInsertRowid), item_code: itemCode, qr_url: `/qr/${itemCode}.png` });
  }

  logOperation(req, 'generate_items', 'item', generated[0]?.item_code || '', `生成子码 ${generated.length} 个${req.agentUser ? '（Agent API）' : ''}`);
  res.json({ success: true, generated, count: generated.length, requestId: req.requestId });
});
app.post('/api/codes/generate/items', requireRole('admin', 'brand_staff'), requireBrowserIdempotency, generateItems);
app.post('/api/agent/codes/items', requireAgentToken, requireAgentRole('admin', 'brand_staff'), requireAgentIdempotency, generateItems);

// 生产码包：一次生成 1～50,000 个码并绑定到唯一任务，供工厂精确导出 TXT。
// 与页面即时生码不同，此流程不预生成数万张 PNG，避免阻塞服务和占满磁盘。
// 网页生码的请求标识永久保留；即使连接中断或服务重启，重试也只能指向原任务。
db.exec(`
  CREATE TABLE IF NOT EXISTS code_package_idempotency (
    user_id INTEGER NOT NULL,
    idempotency_key TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    package_id INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, idempotency_key)
  );
`);
const readCodePackageRequest = db.prepare(`
  SELECT request_hash, package_id FROM code_package_idempotency
  WHERE user_id=? AND idempotency_key=?
`);
app.post('/api/code-packages', requireRole('admin', 'brand_staff'), wrap(async (req, res) => {
  const idempotencyKey = String(req.get('idempotency-key') || '').trim();
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(idempotencyKey)) {
    return res.status(400).json({ success: false, code: 'IDEMPOTENCY_KEY_REQUIRED', msg: '生成码包需要 8～128 位请求标识，请刷新页面后重试' });
  }
  const codeType = req.body.code_type === 'box' ? 'box' : req.body.code_type === 'item' ? 'item' : '';
  const quantity = Number(req.body.quantity);
  const productId = Number(req.body.product_id);
  const batchNo = cleanText(req.body.batch_no, 80);
  if (!codeType) return res.status(400).json({ success: false, code: 'CODE_TYPE_INVALID', msg: '请选择码类型' });
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 50000) {
    return res.status(400).json({ success: false, code: 'QUANTITY_INVALID', msg: '码包数量必须是 1 至 50,000 的整数' });
  }

  const scopeSet = brandScopeSet(req);
  // 品牌主体：品牌方通用码包的权属品牌。
  // brand_staff 固定绑定自身品牌；admin 需显式指定归属品牌。
  const requestedBrand = Number(req.body.brand_id);
  const brandId = scopeSet !== null
    ? (brandInSet(scopeSet, requestedBrand) ? requestedBrand : (brandSetValues(scopeSet)[0] ?? null))
    : requestedBrand;
  if (!Number.isInteger(brandId) || brandId < 1) {
    return res.status(400).json({ success: false, code: 'BRAND_REQUIRED', msg: '请选择码包归属品牌' });
  }
  const brand = db.prepare('SELECT * FROM brands WHERE id=?').get(brandId);
  if (!brand) return res.status(404).json({ success: false, code: 'BRAND_NOT_FOUND', msg: '品牌不存在' });
  if (!brandInSet(scopeSet, brandId)) {
    return res.status(403).json({ success: false, code: 'BRAND_FORBIDDEN', msg: '该品牌不在你的数据范围内' });
  }

  let product = null;
  if (Number.isInteger(productId) && productId > 0) {
    product = db.prepare('SELECT * FROM products WHERE id=?').get(productId);
    if (!product || !brandInSet(scopeSet, product.brand_id)) {
      return res.status(404).json({ success: false, code: 'PRODUCT_NOT_FOUND', msg: '产品不存在或无权访问' });
    }
    if (product.brand_id !== brandId) return res.status(409).json({success:false,code:'PACKAGE_BRAND_CONFLICT',msg:'码包品牌必须与产品品牌一致，请重新选择'});
  }

  const now = new Date();
  const datePart = now.toISOString().slice(0, 10).replace(/-/g, '');
  const packageNo = `PKG-${datePart}-${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
  const user = currentUser(req);
  const isGeneric = !product;

  // 品牌通用码包：不绑定具体产品与批次，生成的空白码（product_id=NULL、batch_no=''）供品牌下任意产品装箱/发货时再绑定。
  const effectiveProductId = product ? product.id : null;
  const effectiveBatchNo = product ? batchNo : '';

  let registeredBatch = null;
  let existingOrigin = null;
  let originTitle = '';
  let originLocation = '';
  let occurredAtInput = '';
  if (product) {
    if (!batchNo) return res.status(400).json({ success: false, code: 'BATCH_REQUIRED', msg: '按产品生成时批次号不能为空，品牌通用码包可留空' });
    registeredBatch = db.prepare(`SELECT * FROM product_batches WHERE product_id=? AND brand_id=? AND batch_no=?`)
      .get(product.id, product.brand_id, batchNo);
    existingOrigin = registeredBatch
      ? db.prepare(`SELECT id FROM batch_trace_entries WHERE batch_id=? AND brand_id=? AND stage_key='origin' ORDER BY id LIMIT 1`).get(registeredBatch.id, product.brand_id)
      : null;
    const needsOrigin = !registeredBatch || !existingOrigin;
    originTitle = cleanText(req.body.origin_title, 100);
    originLocation = cleanText(req.body.origin_location, 120);
    occurredAtInput = cleanText(req.body.occurred_at, 40);
    if (needsOrigin && (!originTitle || !originLocation || !occurredAtInput || Number.isNaN(Date.parse(occurredAtInput)))) {
      return res.status(400).json({ success: false, code: 'BATCH_ORIGIN_REQUIRED', msg: '新批次必须填写原料来源标题、公开地区和有效发生时间' });
    }
  }

  const requestHash = crypto.createHash('sha256').update(JSON.stringify({
    brandId, productId: effectiveProductId, batchNo: effectiveBatchNo,
    quantity, codeType, originTitle, originLocation, occurredAtInput
  })).digest('hex');
  const reserveCodePackage = db.transaction(() => {
    const existing = readCodePackageRequest.get(user.id, idempotencyKey);
    if (existing) return { existing };
    const packageResult = db.prepare(`INSERT INTO code_packages
      (package_no,code_type,brand_id,product_id,batch_no,quantity,base_url,status,created_by,created_by_name)
      VALUES (?,?,?,?,?,?,?,'generating',?,?)`)
      .run(packageNo, codeType, brandId, effectiveProductId, effectiveBatchNo, quantity, getBaseUrl(req), user.id, user.username || '');
    const id = Number(packageResult.lastInsertRowid);
    db.prepare(`INSERT INTO code_package_idempotency
      (user_id,idempotency_key,request_hash,package_id,created_at) VALUES (?,?,?,?,?)`)
      .run(user.id, idempotencyKey, requestHash, id, Date.now());
    return { packageId: id };
  });
  const reservation = reserveCodePackage();
  if (reservation.existing) {
    if (reservation.existing.request_hash !== requestHash) {
      return res.status(409).json({ success: false, code: 'IDEMPOTENCY_CONFLICT', msg: '同一请求标识不能用于不同码包参数' });
    }
    const previous = db.prepare('SELECT * FROM code_packages WHERE id=? AND created_by=?').get(reservation.existing.package_id, user.id);
    if (!previous || previous.brand_id !== brandId) {
      return res.status(409).json({ success: false, code: 'PACKAGE_REQUEST_UNAVAILABLE', msg: '原码包记录不可用，请联系平台管理员' });
    }
    if (previous.status === 'generating') {
      res.setHeader('Retry-After', '2');
      return res.status(409).json({ success: false, code: 'IDEMPOTENCY_IN_PROGRESS', msg: '原码包仍在生成或等待核查，请稍后用同一请求标识重试，不要开启新任务' });
    }
    if (previous.status !== 'ready') {
      return res.status(500).json({ success: false, code: 'PACKAGE_GENERATION_FAILED', msg: '原码包生成失败，未产生完整码数据；请核查记录后开始新任务' });
    }
    res.setHeader('Idempotency-Replayed', 'true');
    return res.status(201).json({
      success: true,
      package: { id: previous.id, package_no: previous.package_no, code_type: previous.code_type,
        quantity: previous.quantity, generic: !previous.product_id, status: 'ready' },
      download_url: `/api/code-packages/${previous.id}/download?mode=url`
    });
  }
  const packageId = reservation.packageId;

  let firstCode = '';
  let lastCode = '';
  let createdBatch = false;
  const insertCode = codeType === 'box'
    ? db.prepare(`INSERT INTO boxes (box_code,product_id,brand_id,batch_no,item_count,package_id) VALUES (?,?,?,?,0,?)`)
    : db.prepare(`INSERT INTO items (item_code,box_id,product_id,brand_id,batch_no,package_id) VALUES (?,NULL,?,?,?,?)`);
  const createPackageCodes = db.transaction(() => {
    if (product) {
      if (!registeredBatch) {
        const batchResult = db.prepare(`INSERT INTO product_batches
          (brand_id,product_id,batch_no,production_date,status,created_by)
          VALUES (?,?,?,?,'draft',?)`)
          .run(product.brand_id, product.id, batchNo, occurredAtInput.slice(0, 10), user.id || null);
        registeredBatch = db.prepare('SELECT * FROM product_batches WHERE id=?').get(batchResult.lastInsertRowid);
        createdBatch = true;
      }
      if (!existingOrigin) {
        const template = db.prepare(`SELECT id FROM product_trace_templates WHERE product_id=? AND brand_id=? AND stage_key='origin'`).get(product.id, product.brand_id);
        db.prepare(`INSERT INTO batch_trace_entries
          (brand_id,batch_id,template_id,stage_key,title,public_location,occurred_at,published,created_by)
          VALUES (?,?,?,'origin',?,?,?,1,?)`)
          .run(product.brand_id, registeredBatch.id, template?.id || null, originTitle, originLocation, new Date(occurredAtInput).toISOString(), user.id || null);
      }
      if (registeredBatch.status !== 'published') {
        db.prepare(`UPDATE product_batches SET status='published',published_at=datetime('now','localtime'),version=version+1,updated_at=datetime('now','localtime') WHERE id=?`).run(registeredBatch.id);
        db.prepare('UPDATE batch_trace_entries SET published=1 WHERE batch_id=? AND brand_id=?').run(registeredBatch.id, product.brand_id);
      }
    }
    for (let index = 0; index < quantity; index++) {
      let code = '';
      let inserted = false;
      for (let attempt = 0; attempt < 5 && !inserted; attempt++) {
        code = `${codeType === 'box' ? 'B' : 'S'}${crypto.randomBytes(12).toString('hex').toUpperCase()}`;
        try {
          if (codeType === 'box') insertCode.run(code, effectiveProductId, brandId, effectiveBatchNo, packageId);
          else insertCode.run(code, effectiveProductId, brandId, effectiveBatchNo, packageId);
          inserted = true;
        } catch (error) {
          if (!String(error.code || '').includes('SQLITE_CONSTRAINT_UNIQUE')) throw error;
        }
      }
      if (!inserted) throw new Error('无法生成唯一溯源码');
      if (!firstCode) firstCode = code;
      lastCode = code;
    }
    db.prepare(`UPDATE code_packages SET status='ready',first_code=?,last_code=?,completed_at=datetime('now','localtime') WHERE id=?`)
      .run(firstCode, lastCode, packageId);
  });

  try {
    createPackageCodes();
  } catch (error) {
    db.prepare(`UPDATE code_packages SET status='failed',error_message=?,completed_at=datetime('now','localtime') WHERE id=?`)
      .run('生成失败，请联系平台管理员', packageId);
    console.error(JSON.stringify({ level: 'error', event: 'code_package_generation_failed', requestId: req.requestId, packageId, message: error.message }));
    logOperation(req, 'generate_code_package_failed', 'code_package', packageId, `码包 ${packageNo} 生成失败`);
    return res.status(500).json({ success: false, code: 'PACKAGE_GENERATION_FAILED', msg: '码包生成失败，未产生不完整码数据', requestId: req.requestId });
  }

  if (createdBatch) {
    logOperation(req, 'create_product_batch', 'product_batch', registeredBatch.id, `随生产码包创建并发布批次「${batchNo}」`);
  }
  logOperation(req, 'generate_code_package', 'code_package', packageId,
    `生成${codeType === 'box' ? '箱码' : '子码'}码包 ${packageNo}${isGeneric ? `，品牌通用（${brand.name}）` : `，产品「${product.name}」，批次「${batchNo}」`}，共 ${quantity} 个`);
  res.status(201).json({
    success: true,
    package: { id: packageId, package_no: packageNo, code_type: codeType, quantity, generic: isGeneric, status: 'ready' },
    download_url: `/api/code-packages/${packageId}/download?mode=url`
  });
}));

// 获取未绑定箱码的子码（用于绑定界面；brand 只看自己品牌；空白码用自身 brand_id 隔离）
app.get('/api/codes/unbound', requireRole('admin', 'brand', 'brand_staff'), (req, res) => {
  const scopeSet = brandScopeSet(req);
  const cond = brandSqlFilter(scopeSet, 'COALESCE(i.brand_id, p.brand_id)');
  const params = scopeSet === null ? [] : brandSetValues(scopeSet);
  const items = db.prepare(`
    SELECT i.item_code, p.name as product_name, i.batch_no, i.created_at
    FROM items i
    LEFT JOIN products p ON i.product_id = p.id
    WHERE i.box_id IS NULL ${cond}
    ORDER BY i.id DESC
    LIMIT 200
  `).all(...params);
  const total = db.prepare(`
    SELECT COUNT(*) as c FROM items i LEFT JOIN products p ON i.product_id=p.id WHERE i.box_id IS NULL ${cond}
  `).get(...params).c;
  res.json({ success: true, items, total });
});

// 查询箱码的详情（含已绑定子码；brand 只能查自己品牌，空白码用自身 brand_id）
app.get('/api/codes/box/:code', requireRole('admin', 'brand', 'brand_staff'), (req, res) => {
  const code = extractCode(req.params.code);
  const box = db.prepare(`
    SELECT b.*, p.name as product_name, COALESCE(b.brand_id, p.brand_id) as eff_brand_id
    FROM boxes b LEFT JOIN products p ON b.product_id = p.id
    WHERE b.box_code = ?
  `).get(code);
  if (!box) return res.json({ success: false, msg: '箱码不存在' });
  if (!brandInSet(brandScopeSet(req), box.eff_brand_id)) return res.json({ success: false, msg: '没有权限查看该箱码' });

  const items = db.prepare(`
    SELECT i.item_code, i.status, i.created_at
    FROM items i WHERE i.box_id = ?
  `).all(box.id);

  res.json({
    success: true,
    box,
    items,
    bound_count: items.length
  });
});

// 绑定子码到箱码（可绑定任意数量；brand 只能操作自己品牌的码）
app.post('/api/codes/bind', requireRole('admin', 'brand', 'brand_staff'), receiptIntegrity.atomic((req, res) => {
  const { item_codes } = req.body;
  const box_code = extractCode(req.body.box_code);
  const scopeSet = brandScopeSet(req);
  if (!box_code) return res.json({ success: false, msg: '请输入箱码' });
  if (!Array.isArray(item_codes) || item_codes.length === 0) return res.json({ success: false, msg: '请选择要绑定的子码' });
  const requestedCodes = [...new Set(item_codes.map(extractCode).filter(Boolean))];
  if (requestedCodes.length === 0 || requestedCodes.length > 5000) return res.status(400).json({ success: false, code: 'INVALID_ITEM_CODES', msg: '子码数量不合法' });

  const box = db.prepare(`
    SELECT b.*, COALESCE(b.brand_id, p.brand_id) as eff_brand_id FROM boxes b LEFT JOIN products p ON b.product_id=p.id WHERE b.box_code=?
  `).get(box_code);
  if (!box) return res.json({ success: false, msg: '箱码不存在' });
  if (!brandInSet(scopeSet, box.eff_brand_id)) return res.json({ success: false, msg: '该箱码不属于你的品牌' });
  if (box.status === 'shipped' || box.distributor_id != null || box.status === 'invalid') return res.json({ success: false, msg: '该箱已发货或作废，不能继续绑定' });
  if (!box.product_id) return res.json({ success: false, msg: '请先为箱码选择产品再绑定子码' });
  const product = db.prepare('SELECT * FROM products WHERE id=?').get(box.product_id);
  if (!product) return res.status(409).json({ success: false, code: 'BOX_PRODUCT_MISSING', msg: '箱码关联的产品不存在，请先核对历史资料' });
  const receiptOwner = operationFactory(req, product, box);
  if (receiptOwner.error) {
    return res.status(receiptOwner.error.includes('请选择') ? 400 : 403).json({ success: false, code: 'RECEIPT_FACTORY_REQUIRED', msg: receiptOwner.error });
  }

  const readBindableItem = db.prepare(`
    SELECT i.*, COALESCE(i.brand_id, p.brand_id) as eff_brand_id
    FROM items i LEFT JOIN products p ON i.product_id=p.id WHERE i.item_code=?
  `);
  const requestedItems = requestedCodes.map(code => readBindableItem.get(code));
  if (requestedItems.some(item => !item || !brandInSet(scopeSet, item.eff_brand_id))) {
    return res.status(404).json({ success: false, code: 'ITEM_NOT_FOUND', msg: '部分子码不存在或无权访问' });
  }
  if (requestedItems.some(item => item.box_id && item.box_id !== box.id)) return res.status(409).json({success:false,msg:'部分子码已在其他箱，本次未绑定'});
  if (requestedItems.some(item => item.receipt_factory_id && Number(item.receipt_factory_id) !== Number(receiptOwner.id))) {
    return res.status(409).json({ success: false, code: 'RECEIPT_FACTORY_CONFLICT', msg: '部分子码已归属其他生产工厂，不能混装' });
  }
  const currentCount = db.prepare('SELECT COUNT(*) c FROM items WHERE box_id=?').get(box.id).c;
  if (box.box_size > 0 && currentCount + requestedItems.filter(item => !item.box_id).length > box.box_size) return res.status(409).json({success:false,msg:'子码数量超过箱规，请先核对箱规'});
  if (receiptIntegrity.boxConflict(box.id)) return res.status(409).json({success:false,msg:'该箱已有商品、品牌或批次冲突，请先核对历史资料'});
  if (requestedItems.some(item => item.status === 'invalid' || itemHasShipment(item) ||
      (item.eff_brand_id && box.eff_brand_id && item.eff_brand_id !== box.eff_brand_id) ||
      (item.product_id && item.product_id !== box.product_id) ||
      (item.batch_no && item.batch_no !== box.batch_no) ||
      (!item.box_id && item.boxed_at))) {
    return res.json({ success: false, msg: '子码已发货、作废、已无箱码入库或商品/品牌不一致，请先处理后绑定' });
  }

  const tx = db.transaction(() => {
    const factory = receiptOwner.id;
    db.prepare('UPDATE boxes SET receipt_factory_id=? WHERE id=?').run(factory, box.id);
    for (const item of requestedItems) {
      if (item.box_id) continue; // 已绑定的跳过
      if (item.status === 'shipped') continue;
      // 箱码有产品则子码跟随箱码产品；箱码为空白码时保留子码自身产品；装箱后状态置为 scanned
      db.prepare("UPDATE items SET box_id=?, product_id=?, brand_id=COALESCE(brand_id, ?), batch_no=?, status='scanned', boxed_at=datetime('now','localtime') WHERE id=?")
        .run(box.id, box.product_id, box.eff_brand_id, box.batch_no || '', item.id);
      db.prepare('UPDATE items SET receipt_factory_id=? WHERE id=?').run(factory, item.id);
      logPackRecord(req, 'bind', box.box_code, item.item_code, product.name, '批量绑定子码', product.spec, box.box_size, 1);
    }
    const count = db.prepare('SELECT COUNT(*) as c FROM items WHERE box_id=?').get(box.id).c;
    db.prepare('UPDATE boxes SET item_count=? WHERE id=?').run(count, box.id);
  });
  tx();

  const count = db.prepare('SELECT COUNT(*) as c FROM items WHERE box_id=?').get(box.id).c;
  res.json({ success: true, msg: `绑定成功，该箱现有 ${count} 个子码`, count });
}));

// 解绑子码（从箱码中移出；brand 只能操作自己品牌）
app.post('/api/codes/unbind', requireRole('admin', 'brand', 'brand_staff'), receiptIntegrity.atomic((req, res) => {
  const item_code = extractCode(req.body.item_code);
  if (!item_code) return res.json({ success: false, msg: '请输入子码' });

  const item = db.prepare(`
    SELECT i.*, COALESCE(i.brand_id, p.brand_id) as eff_brand_id FROM items i LEFT JOIN products p ON i.product_id=p.id WHERE i.item_code=?
  `).get(item_code);
  if (!item) return res.json({ success: false, msg: '子码不存在' });
  if (!brandInSet(brandScopeSet(req), item.eff_brand_id)) return res.json({ success: false, msg: '该子码不属于你的品牌' });
  if (!item.box_id) return res.json({ success: false, msg: '该子码未绑定任何箱码' });
  if (itemHasShipment(item) || item.status === 'invalid') {
    return res.json({ success: false, msg: '该子码已发货或作废，不能解绑' });
  }

  const boxId = item.box_id;
  const tx = db.transaction(() => {
    clearItemReceipt(req, item);
    const count = db.prepare('SELECT COUNT(*) as c FROM items WHERE box_id=?').get(boxId).c;
    db.prepare('UPDATE boxes SET item_count=? WHERE id=?').run(count, boxId);
    if (count === 0) clearBoxReceipt(req, db.prepare('SELECT * FROM boxes WHERE id=?').get(boxId));
  });
  tx();

  res.json({ success: true, msg: '解绑成功' });
}));

// 获取码列表（brand 只看自己品牌的码）
app.get('/api/codes', requireRole('admin', 'brand', 'brand_staff'), (req, res) => {
  const { type, page, keyword, status } = req.query;
  const all = req.query.all === '1';   // 全量模式（批量打印用，上限5000条）
  const pageNum = all ? 1 : (parseInt(page) || 1);
  const pageSize = all ? 5000 : 20;
  const offset = (pageNum - 1) * pageSize;
  const scopeSet = brandScopeSet(req);
  const scopeVals = scopeSet === null ? [] : brandSetValues(scopeSet);
  const scopePh = scopeVals.map(() => '?').join(',');

  if (type === 'box') {
    const conds = [];
    const params = [];
    if (scopeSet !== null) { conds.push(`COALESCE(b.brand_id, p.brand_id) IN (${scopePh})`); params.push(...scopeVals); }
    if (keyword) { conds.push('(b.box_code LIKE ? OR p.name LIKE ?)'); params.push(`%${keyword}%`, `%${keyword}%`); }
    if (status === 'shipped') conds.push("b.status = 'shipped'");
    else if (status === 'in_stock') conds.push("b.status = 'in_stock'");
    else if (status === 'packing') conds.push("b.status = 'packing'");
    else if (status === 'invalid') conds.push("b.status = 'invalid'");
    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
    const total = db.prepare(`SELECT COUNT(*) as c FROM boxes b LEFT JOIN products p ON b.product_id=p.id ${where}`).get(...params).c;
    const boxes = db.prepare(`
      SELECT b.*, p.name as product_name, br.name as brand_name,
        (SELECT COUNT(*) FROM items i WHERE i.box_id=b.id AND i.scanned_at IS NOT NULL) as scanned_count
      FROM boxes b
      LEFT JOIN products p ON b.product_id = p.id
      LEFT JOIN brands br ON br.id = COALESCE(b.brand_id, p.brand_id)
      ${where}
      ORDER BY b.id DESC
      LIMIT ? OFFSET ?
    `).all(...params, pageSize, offset);
    res.json({ success: true, boxes, total, pages: Math.ceil(total / pageSize) });
  } else {
    const conds = [];
    const params = [];
    if (scopeSet !== null) { conds.push(`COALESCE(i.brand_id, p.brand_id) IN (${scopePh})`); params.push(...scopeVals); }
    if (keyword) { conds.push('(i.item_code LIKE ? OR p.name LIKE ?)'); params.push(`%${keyword}%`, `%${keyword}%`); }
    if (status === 'scanned') conds.push("i.status = 'scanned'");
    else if (status === 'shipped') conds.push("i.status = 'shipped'");
    else if (status === 'in_stock') conds.push("i.status = 'in_stock'");
    else if (status === 'packing') conds.push("i.status = 'packing'");
    else if (status === 'invalid') conds.push("i.status = 'invalid'");
    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
    const total = db.prepare(`SELECT COUNT(*) as c FROM items i LEFT JOIN products p ON i.product_id=p.id ${where}`).get(...params).c;
    const items = db.prepare(`
      SELECT i.*, p.name as product_name, br.name as brand_name, b.box_code,
        d.name as distributor_name
      FROM items i
      LEFT JOIN products p ON i.product_id = p.id
      LEFT JOIN brands br ON br.id = COALESCE(i.brand_id, p.brand_id)
      LEFT JOIN boxes b ON i.box_id = b.id
      LEFT JOIN distributors d ON i.distributor_id = d.id
      ${where}
      ORDER BY i.id DESC
      LIMIT ? OFFSET ?
    `).all(...params, pageSize, offset);
    res.json({ success: true, items, total, pages: Math.ceil(total / pageSize) });
  }
});

// --- 代理商管理接口见下方（多品牌版） ---

// ===================== 码删除/作废接口 =====================
// 关键操作留痕（写到 operation_logs 表，便于审计）
function logOperation(req, action, targetType, targetId, detail) {
  try {
    const u = req.agentUser || req.session.user || {};
    db.prepare(`INSERT INTO operation_logs (user_id, username, role, action, target_type, target_id, detail, ip, brand_id)
      VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(u.id || null, u.username || null, u.role || null, action, targetType || null, String(targetId || ''), detail || null, req.ip || null, u.brand_id || null);
  } catch (e) { if (db.inTransaction) throw e; console.error('[logOperation]', e.message); }
}

// 工厂装箱记录：持久化装箱成功/扫错事件，供「扫码记录」统计
function logPackRecord(req, action, box_code, item_code, product_name, detail, spec, box_size, item_count) {
    const u = req.agentUser || req.session.user || {};
    const target = (item_code && db.prepare('SELECT * FROM items WHERE item_code=?').get(item_code)) ||
      (box_code && db.prepare('SELECT * FROM boxes WHERE box_code=?').get(box_code));
    const product = target?.product_id && db.prepare('SELECT * FROM products WHERE id=?').get(target.product_id);
    db.prepare(`INSERT INTO pack_records (user_id, username, factory_id, brand_id, box_code, item_code, product_name, spec, box_size, item_count, action, detail, receipt_factory_id, product_id, batch_no)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(u.id || null, u.username || null, u.factory_id || null, target?.brand_id || product?.brand_id || u.brand_id || null,
        box_code || null, item_code || null, product?.name || product_name || null, product?.spec || spec || null, box_size || null, item_count ?? null, action, detail || null,
        target?.receipt_factory_id || receiptIntegrity.owner(req, product), target?.product_id || null, target?.batch_no || '');
}

function removeGeneratedQr(code) {
  const safeCode = String(code || '');
  if (!/^[A-Z0-9]+$/.test(safeCode)) return;
  try {
    fs.unlinkSync(path.join(__dirname, 'public', 'qr', `${safeCode}.png`));
  } catch (error) {
    if (error.code !== 'ENOENT') console.error(JSON.stringify({ level: 'error', event: 'qr_cleanup_failed', code: safeCode, message: error.message }));
  }
}

function boxHasLifecycleHistory(box) {
  return box.status === 'invalid' || box.status === 'shipped' || box.distributor_id != null || !!box.shipped_at ||
    !!db.prepare('SELECT 1 FROM shipments WHERE box_id=? LIMIT 1').get(box.id) ||
    !!db.prepare('SELECT 1 FROM pack_records WHERE box_code=? LIMIT 1').get(box.box_code);
}
function itemHasLifecycleHistory(item) {
  return item.status === 'invalid' || item.status === 'shipped' || item.distributor_id != null || !!item.shipped_at ||
    !!item.boxed_at || !!item.scanned_at ||
    !!db.prepare('SELECT 1 FROM shipments WHERE item_code=? LIMIT 1').get(item.item_code) ||
    !!db.prepare('SELECT 1 FROM pack_records WHERE item_code=? LIMIT 1').get(item.item_code);
}

// 删除码（admin/brand；未发货/未扫码的码可物理删除）
app.delete('/api/codes/:type/:id', requireRole('admin', 'brand'), (req, res) => {
  const { type, id } = req.params;
  const codeId = parseInt(id);
  const scopeSet = brandScopeSet(req);
  if (!codeId) return res.json({ success: false, msg: '无效的 ID' });
  if (type === 'box') {
    const box = db.prepare(`
      SELECT b.*, COALESCE(b.brand_id, p.brand_id) as brand_id FROM boxes b LEFT JOIN products p ON b.product_id=p.id WHERE b.id=?
    `).get(codeId);
    if (!box) return res.json({ success: false, msg: '箱码不存在' });
    if (!brandInSet(scopeSet, box.brand_id)) return res.json({ success: false, msg: '没有权限操作该箱码' });
    if (boxHasLifecycleHistory(box)) return res.json({ success: false, msg: '该箱码已有入库、作废或发货历史，不能物理删除；溯源记录必须保留' });
    const childCount = db.prepare('SELECT COUNT(*) c FROM items WHERE box_id=?').get(codeId).c;
    if (childCount > 0) return res.json({ success: false, msg: `该箱下还有 ${childCount} 个子码，请先删除子码` });
    db.prepare('DELETE FROM boxes WHERE id=?').run(codeId);
    removeGeneratedQr(box.box_code);
    logOperation(req, 'delete_box', 'box', box.box_code, `箱码「${box.box_code}」已物理删除`);
    return res.json({ success: true, msg: '箱码已删除' });
  } else if (type === 'item') {
    const item = db.prepare(`
      SELECT i.*, COALESCE(i.brand_id, p.brand_id) as brand_id FROM items i LEFT JOIN products p ON i.product_id=p.id WHERE i.id=?
    `).get(codeId);
    if (!item) return res.json({ success: false, msg: '子码不存在' });
    if (!brandInSet(scopeSet, item.brand_id)) return res.json({ success: false, msg: '没有权限操作该子码' });
    if (itemHasLifecycleHistory(item)) return res.json({ success: false, msg: '该子码已有入库、查验、作废或发货历史，不能物理删除；溯源记录必须保留' });
    db.prepare('DELETE FROM items WHERE id=?').run(codeId);
    removeGeneratedQr(item.item_code);
    logOperation(req, 'delete_item', 'item', item.item_code, `子码「${item.item_code}」已物理删除`);
    return res.json({ success: true, msg: '子码已删除' });
  }
  return res.json({ success: false, msg: '不支持的码类型' });
});

// 批量删除码（admin/brand；只删可物理删除的码，其余跳过并返回原因）
app.post('/api/codes/batch-delete', requireRole('admin', 'brand'), (req, res) => {
  const { type, ids } = req.body || {};
  const scopeSet = brandScopeSet(req);
  if (!['box', 'item'].includes(type)) return res.json({ success: false, msg: '不支持的码类型' });
  if (!Array.isArray(ids) || ids.length === 0) return res.json({ success: false, msg: '请先勾选要删除的码' });
  if (ids.length > 500) return res.json({ success: false, msg: '单次最多删除 500 个' });

  const deleted = [];
  const skipped = [];

  const run = db.transaction(() => {
    for (const rawId of ids) {
      const codeId = parseInt(rawId);
      if (!codeId) { skipped.push({ code: String(rawId), msg: '无效 ID' }); continue; }
      if (type === 'box') {
        const box = db.prepare(`
          SELECT b.*, COALESCE(b.brand_id, p.brand_id) as brand_id FROM boxes b LEFT JOIN products p ON b.product_id=p.id WHERE b.id=?
        `).get(codeId);
        if (!box) { skipped.push({ code: String(rawId), msg: '不存在' }); continue; }
        if (!brandInSet(scopeSet, box.brand_id)) { skipped.push({ code: box.box_code, msg: '无权限' }); continue; }
        if (boxHasLifecycleHistory(box)) { skipped.push({ code: box.box_code, msg: '已有业务历史' }); continue; }
        const childCount = db.prepare('SELECT COUNT(*) c FROM items WHERE box_id=?').get(codeId).c;
        if (childCount > 0) { skipped.push({ code: box.box_code, msg: `箱下还有 ${childCount} 个子码` }); continue; }
        db.prepare('DELETE FROM boxes WHERE id=?').run(codeId);
        logOperation(req, 'delete_box', 'box', box.box_code, `箱码「${box.box_code}」批量删除`);
        deleted.push(box.box_code);
      } else {
        const item = db.prepare(`
          SELECT i.*, COALESCE(i.brand_id, p.brand_id) as brand_id FROM items i LEFT JOIN products p ON i.product_id=p.id WHERE i.id=?
        `).get(codeId);
        if (!item) { skipped.push({ code: String(rawId), msg: '不存在' }); continue; }
        if (!brandInSet(scopeSet, item.brand_id)) { skipped.push({ code: item.item_code, msg: '无权限' }); continue; }
        if (itemHasLifecycleHistory(item)) { skipped.push({ code: item.item_code, msg: '已有业务历史' }); continue; }
        db.prepare('DELETE FROM items WHERE id=?').run(codeId);
        logOperation(req, 'delete_item', 'item', item.item_code, `子码「${item.item_code}」批量删除`);
        deleted.push(item.item_code);
      }
    }
  });
  run();
  for (const code of deleted) removeGeneratedQr(code);

  let msg = `已删除 ${deleted.length} 个${type === 'box' ? '箱码' : '子码'}`;
  if (skipped.length) msg += `，跳过 ${skipped.length} 个（已有业务历史或箱下有子码的不可删除）`;
  res.json({ success: true, deleted: deleted.length, skipped, msg });
});

// 标记作废（admin/brand；任何状态的码都可作废，作废后视为失效，仍保留溯源记录）
app.patch('/api/codes/:type/:id/invalidate', requireRole('admin', 'brand'), (req, res) => {
  const { type, id } = req.params;
  const codeId = parseInt(id);
  const scopeSet = brandScopeSet(req);
  if (!codeId) return res.json({ success: false, msg: '无效的 ID' });
  const { reason } = req.body || {};
  if (type === 'box') {
    const box = db.prepare(`
      SELECT b.*, COALESCE(b.brand_id, p.brand_id) as brand_id FROM boxes b LEFT JOIN products p ON b.product_id=p.id WHERE b.id=?
    `).get(codeId);
    if (!box) return res.json({ success: false, msg: '箱码不存在' });
    if (!brandInSet(scopeSet, box.brand_id)) return res.json({ success: false, msg: '没有权限操作该箱码' });
    if (box.status === 'invalid') return res.json({ success: false, msg: '该箱已是作废状态' });
    db.prepare("UPDATE boxes SET status='invalid' WHERE id=?").run(codeId);
    logOperation(req, 'invalidate_box', 'box', box.box_code, `箱码「${box.box_code}」已标记作废${reason ? '，原因：' + reason : ''}`);
    return res.json({ success: true, msg: '箱码已标记作废' });
  } else if (type === 'item') {
    const item = db.prepare(`
      SELECT i.*, COALESCE(i.brand_id, p.brand_id) as brand_id FROM items i LEFT JOIN products p ON i.product_id=p.id WHERE i.id=?
    `).get(codeId);
    if (!item) return res.json({ success: false, msg: '子码不存在' });
    if (!brandInSet(scopeSet, item.brand_id)) return res.json({ success: false, msg: '没有权限操作该子码' });
    if (item.status === 'invalid') return res.json({ success: false, msg: '该子码已是作废状态' });
    db.prepare("UPDATE items SET status='invalid' WHERE id=?").run(codeId);
    logOperation(req, 'invalidate_item', 'item', item.item_code, `子码「${item.item_code}」已标记作废${reason ? '，原因：' + reason : ''}`);
    return res.json({ success: true, msg: '子码已标记作废' });
  }
  return res.json({ success: false, msg: '不支持的码类型' });
});

// 操作日志查询接口（brand 只看自己品牌的操作）
app.get('/api/operation_logs', requireRole('admin', 'brand', 'brand_staff'), (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 100, 500);
  const scopeSet = brandScopeSet(req);
  const scopeVals = scopeSet === null ? [] : brandSetValues(scopeSet);
  const scopePh = scopeVals.map(() => '?').join(',');
  const rows = scopeSet === null
    ? db.prepare('SELECT * FROM operation_logs ORDER BY id DESC LIMIT ?').all(limit)
    : db.prepare(`SELECT * FROM operation_logs WHERE brand_id IN (${scopePh}) ORDER BY id DESC LIMIT ?`).all(...scopeVals, limit);
  res.json({ success: true, logs: rows });
});

// --- 代理商管理（brand 只能管理自己品牌的代理商） ---

// 解析代理商覆盖区域（多选：省级/市级）。regions: [{province, city}]
function parseCoveredRegions(regions) {
  const list = Array.isArray(regions) ? regions : [];
  const cleaned = [];
  const displayParts = [];
  for (const r of list) {
    const province = String(r && r.province || '').trim();
    const city = String(r && r.city || '').trim();
    if (!province || !Object.hasOwn(CHINA_REGIONS, province)) continue;
    if (city && !CHINA_REGIONS[province].includes(city)) continue;
    cleaned.push({ p: province, c: city });
    displayParts.push(city ? `${province}${city}` : `${province}（全省）`);
  }
  if (!cleaned.length) return null;
  const primary = cleaned[0];
  return {
    covered_regions: JSON.stringify(cleaned),
    region: displayParts.join('；'),
    country: '中国',
    province: primary.c,
    region_province: primary.p,      // 首个区域所在的省（用于兼容单省展示/导出）
    city: primary.c || ''
  };
}

app.get('/api/regions', (req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.json({ success: true, countries: [{ name: '中国', provinces: CHINA_REGIONS }] });
});

app.get('/api/distributors', requireRole('admin', 'brand', 'brand_staff'), (req, res) => {
  const scope = brandScope(req);
  const scopeSet = brandScopeSet(req);
  const base = `SELECT d.*, b.name AS brand_name,
    (SELECT group_concat(bx.name, '、') FROM distributor_brands db2 JOIN brands bx ON bx.id=db2.brand_id WHERE db2.distributor_id=d.id) AS brand_names
    FROM distributors d LEFT JOIN brands b ON d.brand_id=b.id`;
  let distributors;
  if (scopeSet === null) {
    distributors = db.prepare(base + ' ORDER BY d.id DESC').all();
  } else {
    const vals = brandSetValues(scopeSet);
    const placeholders = vals.map(() => '?').join(',');
    distributors = db.prepare(`${base} WHERE d.brand_id IN (${placeholders}) OR EXISTS (SELECT 1 FROM distributor_brands db3 WHERE db3.distributor_id=d.id AND db3.brand_id IN (${placeholders})) ORDER BY d.id DESC`).all(...vals, ...vals);
  }
  // 附带每个代理商的品牌 id 数组，供前端回显多选
  const brandMap = {};
  db.prepare('SELECT distributor_id, brand_id FROM distributor_brands').all().forEach(r => {
    (brandMap[r.distributor_id] = brandMap[r.distributor_id] || []).push(r.brand_id);
  });
  distributors.forEach(d => { d.brand_ids = brandMap[d.id] || (d.brand_id ? [d.brand_id] : []); });
  res.json({ success: true, distributors });
});

// 写入/更新代理商的品牌集合（多品牌）。
function applyDistributorBrands(distributorId, brandIds, scopeSet) {
  if (!Array.isArray(brandIds)) return;
  // 归一化并去重
  const ids = [...new Set(brandIds.map(x => Number(x)).filter(x => Number.isInteger(x) && x > 0))];
  // 品牌集合受限时，仅允许写入范围内品牌
  const final = scopeSet === null ? ids : ids.filter(x => brandInSet(scopeSet, x));
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM distributor_brands WHERE distributor_id=?').run(distributorId);
    const ins = db.prepare('INSERT OR IGNORE INTO distributor_brands (distributor_id, brand_id) VALUES (?,?)');
    final.forEach(bid => ins.run(distributorId, bid));
    // 主品牌 brand_id 同步为多品牌里的第一个（兼容旧逻辑兜底）
    const first = final[0] ?? null;
    if (first) db.prepare('UPDATE distributors SET brand_id=? WHERE id=?').run(first, distributorId);
  });
  tx();
  return final;
}

// 新增代理商
app.post('/api/distributors', requireRole('admin', 'brand', 'brand_staff'), (req, res) => {
  const { name, phone, address, regions, brand_ids } = req.body;
  const scopeSet = brandScopeSet(req);
  if (!name) return res.json({ success: false, msg: '代理商名称不能为空' });
  let covered = parseCoveredRegions(regions);
  if (!covered) {
    // 兼容旧单省市提交
    const sr = normalizeRegionSelection(req.body.country, req.body.province, req.body.city);
    if (!sr) return res.status(400).json({ success: false, code: 'INVALID_REGION_SELECTION', msg: '请选择有效的覆盖区域（省或市）' });
    covered = { covered_regions: JSON.stringify([{ p: sr.province, c: sr.city }]), region: sr.region, country: sr.country, province: sr.city, region_province: sr.province, city: sr.city };
  }
  // 解析多品牌：优先 brand_ids 数组，其次兼容旧单品牌 brand_id
  let brandIds = Array.isArray(brand_ids)
    ? brand_ids.map(x => Number(x)).filter(x => Number.isInteger(x) && x > 0)
    : [];
  if (brandIds.length === 0) {
    const requested = parseInt(req.body.brand_id) || null;
    const single = scopeSet !== null
      ? (brandInSet(scopeSet, requested) ? requested : (brandSetValues(scopeSet)[0] ?? null))
      : requested;
    if (single) brandIds = [single];
  }
  if (scopeSet !== null) brandIds = brandIds.filter(x => brandInSet(scopeSet, x));
  if (brandIds.length === 0) return res.json({ success: false, msg: '请至少选择一个归属品牌' });
  const primaryBrand = brandIds[0];
  if (!db.prepare('SELECT 1 FROM brands WHERE id=? AND enabled=1').get(primaryBrand)) {
    return res.json({ success: false, msg: '所选品牌不存在或已停用' });
  }
  const result = db.prepare('INSERT INTO distributors (name, phone, region, address, brand_id, country, province, covered_regions) VALUES (?,?,?,?,?,?,?,?)')
    .run(name, phone || '', covered.region, address || '', primaryBrand, covered.country, covered.region_province, covered.covered_regions);
  const newId = result.lastInsertRowid;
  applyDistributorBrands(newId, brandIds, scopeSet);
  res.json({ success: true, id: newId });
});

// 删除代理商（brand 只能删自己品牌的）
app.delete('/api/distributors/:id', requireRole('admin', 'brand', 'brand_staff'), (req, res) => {
  const { id } = req.params;
  const d = db.prepare('SELECT * FROM distributors WHERE id=?').get(id);
  if (!d) return res.json({ success: false, msg: '代理商不存在' });
  if (!distributorInScope(brandScopeSet(req), d)) return res.json({ success: false, msg: '没有权限操作该代理商' });
  db.prepare('DELETE FROM distributors WHERE id=?').run(id);
  res.json({ success: true });
});

// 更新代理商（brand 只能改自己品牌的）
app.put('/api/distributors/:id', requireRole('admin', 'brand', 'brand_staff'), (req, res) => {
  const { id } = req.params;
  const d = db.prepare('SELECT * FROM distributors WHERE id=?').get(id);
  if (!d) return res.json({ success: false, msg: '代理商不存在' });
  if (!distributorInScope(brandScopeSet(req), d)) return res.json({ success: false, msg: '没有权限操作该代理商' });
  const { name, phone, address, regions, brand_ids } = req.body;
  let covered = parseCoveredRegions(regions);
  if (!covered) {
    const sr = normalizeRegionSelection(req.body.country, req.body.province, req.body.city);
    if (!sr) return res.status(400).json({ success: false, code: 'INVALID_REGION_SELECTION', msg: '请选择有效的覆盖区域（省或市）' });
    covered = { covered_regions: JSON.stringify([{ p: sr.province, c: sr.city }]), region: sr.region, country: sr.country, province: sr.city, region_province: sr.province, city: sr.city };
  }
  db.prepare('UPDATE distributors SET name=?, phone=?, region=?, address=?, country=?, province=?, covered_regions=? WHERE id=?')
    .run(name, phone || '', covered.region, address || '', covered.country, covered.region_province, covered.covered_regions, id);
  // 多品牌更新（带品牌集合时）
  if (Array.isArray(brand_ids)) {
    applyDistributorBrands(Number(id), brand_ids, brandScopeSet(req));
  }
  res.json({ success: true });
});

// --- 工厂装箱 ---

// 扫箱码开始装箱：返回箱信息 + 已绑子码列表
// 空白箱码（未绑产品）返回 need_product=true，前端引导选择产品+箱规
app.post('/api/factory/pack/start', requireRole('admin', 'factory', 'brand', 'brand_staff'), (req, res) => {
  const box_code = extractCode(req.body.box_code);
  if (!box_code) return res.json({ success: false, msg: '请输入箱码' });

  const box = db.prepare(`
    SELECT b.*, p.name as product_name, p.spec as product_spec, p.box_size as product_box_size, p.factory_id as product_factory_id,
      COALESCE(b.brand_id, p.brand_id) as eff_brand_id
    FROM boxes b LEFT JOIN products p ON b.product_id = p.id
    WHERE b.box_code = ?
  `).get(box_code);
  if (!box) return res.json({ success: false, msg: '箱码不存在' });
  if (box.status === 'shipped') return res.json({ success: false, msg: '该箱已发货，不能继续装箱' });
  if (box.status === 'invalid') return res.json({ success: false, msg: '该箱码已作废，无法装箱' });
  // 空白码先按品牌隔离；一旦入库，receipt_factory_id 锁定实际生产工厂。
  const scopeSet = brandScopeSet(req);
  if (!brandInSet(scopeSet, box.eff_brand_id)) {
    return res.json({ success: false, msg: '该箱码不属于你的品牌，无法装箱' });
  }
  if (!factoryReceiptAllowed(req, box)) {
    return res.status(404).json({ success: false, code: 'RECEIPT_FACTORY_FORBIDDEN', msg: '箱码不存在或不属于当前工厂' });
  }
  const operator = currentUser(req);
  if (operator?.role === 'factory' && box.product_id && !factoryAssignedToProduct(operator.factory_id, box.product_id)) {
    return res.status(403).json({ success: false, code: 'PRODUCT_FACTORY_FORBIDDEN', msg: '该产品未授权给当前工厂装箱' });
  }

  const items = db.prepare(`
    SELECT i.item_code, COALESCE(i.boxed_at, i.created_at) AS bound_at FROM items i WHERE i.box_id = ? ORDER BY i.id
  `).all(box.id);

  res.json({
    success: true,
    box,
    items,
    bound_count: items.length,
    box_size: box.box_size || box.product_box_size || 0,
    need_product: !box.product_id          // 空白箱码：需先选择产品
  });
});

// 为箱码选择产品+箱规（空白箱码装箱第一步；也可中途换产品）
app.post('/api/factory/pack/set-product', requireRole('admin', 'factory', 'brand', 'brand_staff'), receiptIntegrity.atomic((req, res) => {
  const box_code = extractCode(req.body.box_code);
  const product_id = parseInt(req.body.product_id);
  const box_size = parseInt(req.body.box_size) || 0;
  const batch_no = (req.body.batch_no || '').trim();
  if (!box_code) return res.json({ success: false, msg: '请输入箱码' });
  if (!product_id) return res.json({ success: false, msg: '请选择产品' });

  const box = db.prepare('SELECT * FROM boxes WHERE box_code=?').get(box_code);
  if (!box) return res.json({ success: false, msg: '箱码不存在' });
  if (box.status === 'shipped') return res.json({ success: false, msg: '该箱已发货，不能修改' });
  if (box.status === 'invalid') return res.json({ success: false, msg: '该箱码已作废' });

  const product = scopedProduct(req, product_id);
  if (!product) return res.status(404).json({ success: false, msg: '产品不存在或未授权给当前工厂' });
  const receiptOwner = operationFactory(req, product, box);
  if (receiptOwner.error) {
    return res.status(receiptOwner.error.includes('请选择') ? 400 : 403).json({ success: false, code: 'RECEIPT_FACTORY_REQUIRED', msg: receiptOwner.error });
  }

  const scopeSet = brandScopeSet(req);
  if (!brandInSet(scopeSet, box.brand_id)) return res.json({ success: false, msg: '该箱码不属于你的品牌' });
  if (!brandInSet(scopeSet, product.brand_id)) return res.json({ success: false, msg: '该产品不属于你的品牌' });

  if (box.brand_id && product.brand_id && box.brand_id !== product.brand_id) return res.json({ success: false, msg: '箱码与产品的品牌不一致' });

  // 该箱已绑定的子码若属于其他产品，禁止切换（防止混装数据错乱）
  const conflict = db.prepare('SELECT COUNT(*) as c FROM items WHERE box_id=? AND product_id IS NOT NULL AND product_id != ?')
    .get(box.id, product_id).c;
  if (conflict > 0) {
    return res.json({ success: false, msg: `该箱已绑定 ${conflict} 个其他产品的子码，不能切换产品，请先联系管理员解绑` });
  }

  const effectiveSize = box_size || product.box_size || 0;
  const boundCount = db.prepare('SELECT COUNT(*) c FROM items WHERE box_id=?').get(box.id).c;
  if (!batch_no && !box.batch_no) return res.status(400).json({success:false,msg:'请输入批次号'});
  if (!Number.isSafeInteger(effectiveSize) || effectiveSize < 1 || effectiveSize < boundCount) return res.status(400).json({success:false,msg:'箱规必须为正整数且不能小于已绑子码数量'});
  db.prepare('UPDATE boxes SET product_id=?, brand_id=COALESCE(?, ?), batch_no=?, box_size=?, receipt_factory_id=? WHERE id=?')
    .run(product_id, product.brand_id, box.brand_id, batch_no || box.batch_no, effectiveSize, receiptOwner.id, box.id);
  logOperation(req, 'pack_set_product', 'box', box.box_code, `箱码「${box.box_code}」设置产品：${product.name}${box_size ? `，箱规 ${box_size}` : ''}`);

  res.json({ success: true, msg: `已选择产品：${product.name}`, box_size: box_size || product.box_size || 0 });
}));

// 扫子码绑定到当前箱（带防错）
app.post('/api/factory/pack/scan', requireRole('admin', 'factory', 'brand', 'brand_staff'), receiptIntegrity.atomic((req, res) => {
  const box_code = extractCode(req.body.box_code);
  const item_code = extractCode(req.body.item_code);
  if (!box_code) return res.json({ success: false, msg: '请先扫箱码' });
  if (!item_code) return res.json({ success: false, msg: '请输入子码' });

  const box = db.prepare(`
    SELECT b.*, p.box_size as product_box_size, p.spec as product_spec,
      COALESCE(b.brand_id, p.brand_id) as eff_brand_id
    FROM boxes b LEFT JOIN products p ON b.product_id = p.id
    WHERE b.box_code = ?
  `).get(box_code);
  if (!box) return res.json({ success: false, msg: '箱码不存在' });
  if (box.status === 'shipped') return res.json({ success: false, msg: '该箱已发货，不能继续绑定' });
  if (box.status === 'invalid') return res.json({ success: false, msg: '该箱码已作废，不能绑定' });
  // 品牌和产品授权通过后，仍需校验该实物箱的实际生产工厂归属。
  const scopeSet = brandScopeSet(req);
  if (!brandInSet(scopeSet, box.eff_brand_id)) {
    return res.json({ success: false, msg: '该箱码不属于你的品牌，无法装箱' });
  }
  if (!factoryReceiptAllowed(req, box)) {
    return res.status(404).json({ success: false, code: 'RECEIPT_FACTORY_FORBIDDEN', msg: '箱码不存在或不属于当前工厂' });
  }
  const operator = currentUser(req);
  if (operator?.role === 'factory' && box.product_id && !factoryAssignedToProduct(operator.factory_id, box.product_id)) {
    return res.status(403).json({ success: false, code: 'PRODUCT_FACTORY_FORBIDDEN', msg: '该产品未授权给当前工厂装箱' });
  }

  // 空白箱码必须先选产品再扫子码
  if (!box.product_id) {
    return res.json({ success: false, msg: '该箱还未选择产品，请先在上方选择产品并确认箱规' });
  }
  const product = db.prepare('SELECT * FROM products WHERE id=?').get(box.product_id);
  const receiptOwner = product ? operationFactory(req, product, box) : { error: '箱码产品不存在' };
  if (receiptOwner.error) {
    return res.status(receiptOwner.error.includes('请选择') ? 400 : 403).json({ success: false, code: 'RECEIPT_FACTORY_REQUIRED', msg: receiptOwner.error });
  }
  if (receiptIntegrity.boxConflict(box.id)) return res.status(409).json({success:false,msg:'该箱已有商品、品牌或批次冲突，请先核对历史资料'});

  // 箱规：优先用前端传的（工人可临时改），否则用产品默认箱规
  const boxSize = parseInt(req.body.box_size) || box.box_size || box.product_box_size || 0;
  if (!Number.isSafeInteger(boxSize) || boxSize < 1 || !box.batch_no) return res.status(400).json({success:false,msg:'请先确认有效箱规和批次'});

  const item = db.prepare(`
    SELECT i.*, p.name as product_name, p.spec as product_spec, COALESCE(i.brand_id, p.brand_id) as eff_brand_id FROM items i
    LEFT JOIN products p ON i.product_id = p.id
    WHERE i.item_code = ?
  `).get(item_code);
  if (!item) return res.json({ success: false, msg: '子码不存在' });
  if (!brandInSet(scopeSet, item.eff_brand_id)) return res.status(404).json({ success: false, code: 'ITEM_NOT_FOUND', msg: '子码不存在或无权访问' });
  if (db.prepare('SELECT 1 FROM factory_nobox_pending WHERE item_id=?').get(item.id)) return res.status(409).json({ success: false, msg: '该子码已在无箱码待入库清单，请先确认入库或从清单移除' });
  if (!factoryReceiptAllowed(req, item)) return res.status(404).json({ success: false, code: 'RECEIPT_FACTORY_FORBIDDEN', msg: '子码不存在或不属于当前工厂' });
  if (item.receipt_factory_id && Number(item.receipt_factory_id) !== Number(receiptOwner.id)) {
    return res.status(409).json({ success: false, code: 'RECEIPT_FACTORY_CONFLICT', msg: '子码与箱码的生产工厂不一致，不能混装' });
  }

  const curBound = db.prepare('SELECT COUNT(*) as c FROM items WHERE box_id=?').get(box.id).c;

  // 防错1：已绑定本箱（重复扫）——先于满箱判断，给出更精确的提示
  if (item.box_id === box.id) {
    logPackRecord(req, 'error', box.box_code, item_code, item.product_name, '重复扫码', item.product_spec || box.product_spec, boxSize, curBound);
    return res.json({ success: false, msg: `该子码已在本箱（已绑 ${curBound} 个），请勿重复扫码`, bound_count: curBound });
  }
  // 防错0：已扫满箱规，拒绝继续绑定
  if (boxSize > 0 && curBound >= boxSize) {
    logPackRecord(req, 'error', box.box_code, item_code, item.product_name, '箱已满', item.product_spec || box.product_spec, boxSize, curBound);
    return res.json({ success: false, msg: box.status === 'packing' ? '本箱已装满，请先确认入库' : '本箱已入库，请扫下一个箱码', bound_count: curBound, box_size: boxSize, full: true });
  }
  // 防错2：已绑定其他箱
  if (item.box_id) {
    const otherBox = db.prepare('SELECT box_code FROM boxes WHERE id=?').get(item.box_id);
    logPackRecord(req, 'error', box.box_code, item_code, item.product_name, '已绑其他箱', item.product_spec || box.product_spec, boxSize, curBound);
    return res.json({ success: false, msg: `该子码已绑定箱码 ${otherBox?.box_code || ''}，不能重复装箱`, bound_count: curBound });
  }
  // 防错3：已发货
  if (itemHasShipment(item)) {
    logPackRecord(req, 'error', box.box_code, item_code, item.product_name, '已发货', item.product_spec || box.product_spec, boxSize, curBound);
    return res.json({ success: false, msg: `该子码已发货，不能装箱`, bound_count: curBound });
  }
  // 防错4：产品不符（空白子码 product_id 为空，绑定时自动跟随箱码产品，不算不符）
  if (item.status === 'invalid') return res.json({ success: false, msg: '该子码已作废，不能装箱' });
  if (item.boxed_at) return res.json({ success: false, msg: '该子码已无箱码入库，请先取消无箱码入库再装箱' });
  if (item.batch_no && item.batch_no !== box.batch_no) return res.status(409).json({success:false,msg:'子码与箱码的批次不一致，不能混装'});
  if (item.eff_brand_id && box.eff_brand_id && item.eff_brand_id !== box.eff_brand_id) return res.json({ success: false, msg: '子码与箱码的品牌不一致' });
  if (box.product_id && item.product_id && box.product_id !== item.product_id) {
    logPackRecord(req, 'error', box.box_code, item_code, item.product_name, '产品不符', item.product_spec || box.product_spec, boxSize, curBound);
    return res.json({ success: false, msg: `产品不符！箱码产品与子码产品不一致`, bound_count: curBound });
  }

  // 扫描只进入待确认装箱态，不计作正式入库；确认接口再一次性提交整箱。
  db.prepare("UPDATE items SET box_id=?, product_id=COALESCE(?, product_id), brand_id=COALESCE(brand_id, ?), batch_no=?, status='packing', boxed_at=datetime('now','localtime') WHERE id=?")
    .run(box.id, box.product_id, box.eff_brand_id, box.batch_no || '', item.id);
  const count = curBound + 1;
  const factory = receiptIntegrity.owner(req, product, box, receiptOwner.id);
  db.prepare('UPDATE items SET receipt_factory_id=? WHERE id=?').run(factory, item.id);
  db.prepare("UPDATE boxes SET item_count=?,box_size=?,receipt_factory_id=?,status='packing' WHERE id=?").run(count, boxSize, factory, box.id);
  db.prepare("UPDATE items SET status='packing' WHERE box_id=? AND status='scanned'").run(box.id);

  const items = db.prepare("SELECT item_code, COALESCE(boxed_at, created_at) AS bound_at FROM items WHERE box_id=? ORDER BY id").all(box.id);

  // 记录装箱（绑子码 / 装箱完成）
  const packedFull = boxSize > 0 && count >= boxSize;
  logPackRecord(req, packedFull ? 'box_full_pending' : 'bind_pending', box.box_code, item_code, item.product_name, packedFull ? `待确认入库 ${count}/${boxSize}` : '待确认装箱', item.product_spec || box.product_spec, boxSize, count);

  res.json({
    success: true,
    msg: `绑定成功`,
    item_code: item_code,
    item_product_name: product.name,
    bound_count: count,
    box_size: boxSize,
    full: boxSize > 0 && count >= boxSize,   // 扫满标记，前端自动提示完成
    items: items
  });
}));

// 已扫满且尚未入库的箱码清单，工厂端刷新后仍能找回待确认项。
app.get('/api/factory/pack/pending-stock', requireRole('admin', 'factory', 'brand', 'brand_staff'), (req, res) => {
  const rows = db.prepare(`SELECT b.id, b.box_code, b.status, b.brand_id, b.product_id, b.batch_no,
      b.box_size, b.receipt_factory_id, p.name AS product_name, p.spec AS product_spec,
      COUNT(i.id) AS quantity,
      SUM(CASE WHEN i.status='packing' THEN 1 ELSE 0 END) AS pending_items
    FROM boxes b
    JOIN products p ON p.id=b.product_id
    JOIN items i ON i.box_id=b.id
    WHERE b.status='packing' AND b.box_size>0
    GROUP BY b.id
    HAVING quantity=b.box_size AND pending_items=b.box_size
    ORDER BY b.id`).all();
  const scopeSet = brandScopeSet(req);
  const pending = rows.filter(box => brandInSet(scopeSet, box.brand_id) && factoryReceiptAllowed(req, box))
    .map(({ id, box_code, product_name, product_spec, quantity, box_size, batch_no }) =>
      ({ id, box_code, product_name, product_spec, quantity: Number(quantity), box_size: Number(box_size), batch_no }));
  res.json({ success: true, boxes: pending });
});

// 满箱后确认一箱或多箱入库；批量状态转换和审计在同一事务内完成，重复提交幂等。
app.post('/api/factory/pack/confirm-stock', requireRole('admin', 'factory', 'brand', 'brand_staff'), receiptIntegrity.atomic((req, res) => {
  const rawCodes = Array.isArray(req.body.box_codes) ? req.body.box_codes : [req.body.box_code];
  const boxCodes = [...new Set(rawCodes.map(code => extractCode(code)).filter(Boolean))];
  if (!boxCodes.length) return res.status(400).json({ success: false, msg: '待入库清单为空' });
  if (boxCodes.length > 200) return res.status(400).json({ success: false, msg: '单次最多确认 200 箱' });
  const scopeSet = brandScopeSet(req);
  const confirmed = [];
  let alreadyConfirmed = 0;
  for (const box_code of boxCodes) {
    const box = db.prepare('SELECT * FROM boxes WHERE box_code=?').get(box_code);
    if (!box) return res.status(404).json({ success: false, msg: `箱码 ${box_code} 不存在` });
    if (box.status === 'shipped' || box.status === 'invalid') return res.status(409).json({ success: false, msg: `箱码 ${box_code} 已发货或作废，不能确认入库` });
    if (!brandInSet(scopeSet, box.brand_id) || !factoryReceiptAllowed(req, box)) return res.status(404).json({ success: false, msg: `箱码 ${box_code} 不存在或无权操作` });
    if (!box.product_id || !box.batch_no || !box.receipt_factory_id || !Number.isInteger(box.box_size) || box.box_size < 1) {
      return res.status(409).json({ success: false, msg: `箱码 ${box_code} 的产品、批次、箱规或工厂信息不完整` });
    }
    const count = db.prepare('SELECT COUNT(*) c FROM items WHERE box_id=?').get(box.id).c;
    if (count !== box.box_size) return res.status(409).json({ success: false, msg: `箱码 ${box_code} 尚未扫满：${count}/${box.box_size}` });
    if (box.status === 'in_stock') { alreadyConfirmed++; continue; }
    if (box.status !== 'packing') return res.status(409).json({ success: false, msg: `箱码 ${box_code} 不在待确认状态` });
    const conflict = db.prepare(`SELECT COUNT(*) c FROM items WHERE box_id=? AND
      (status!='packing' OR product_id IS NOT ? OR brand_id IS NOT ? OR batch_no IS NOT ? OR receipt_factory_id IS NOT ?)`).get(box.id, box.product_id, box.brand_id, box.batch_no, box.receipt_factory_id).c;
    if (conflict) return res.status(409).json({ success: false, msg: `箱码 ${box_code} 内子码信息不一致，已阻止本次批量入库` });
    confirmed.push({ box, count });
  }
  for (const { box, count } of confirmed) {
    db.prepare("UPDATE boxes SET status='in_stock',item_count=? WHERE id=? AND status='packing'").run(count, box.id);
    db.prepare("UPDATE items SET status='scanned' WHERE box_id=? AND status='packing'").run(box.id);
    logPackRecord(req, 'box_full', box.box_code, null, null, `确认入库 ${count}/${box.box_size}`, null, box.box_size, count);
    logOperation(req, 'confirm_stock', 'box', box.box_code, `确认入库 ${count}/${box.box_size}`);
  }
  const allAlreadyConfirmed = confirmed.length === 0;
  res.json({ success: true, already_confirmed: allAlreadyConfirmed, msg: allAlreadyConfirmed ? '清单中的箱码已确认入库' : `已确认入库 ${confirmed.length} 箱`, confirmed_count: confirmed.length, already_confirmed_count: alreadyConfirmed, boxes: boxCodes });
}));

// 无箱码入库：扫码先进入服务器持久清单，确认前不改 items 库存状态。
function pendingNoBoxVisible(req, row) {
  if (!row || !brandInSet(brandScopeSet(req), row.brand_id)) return false;
  const user = currentUser(req);
  return user?.role === 'factory'
    ? Number(row.factory_id) === Number(user.factory_id)
    : Number(row.created_by) === Number(user?.id);
}

app.get('/api/factory/pack/pending-nobox', requireRole('admin', 'factory', 'brand', 'brand_staff'), (req, res) => {
  const user = currentUser(req);
  const where = user.role === 'factory' ? 'q.factory_id=?' : 'q.created_by=?';
  const rows = db.prepare(`SELECT q.*, p.name AS product_name, p.spec AS product_spec
    FROM factory_nobox_pending q JOIN products p ON p.id=q.product_id
    WHERE ${where} ORDER BY q.created_at,q.item_code`).all(user.role === 'factory' ? user.factory_id : user.id);
  res.json({ success: true, items: rows.filter(row => pendingNoBoxVisible(req, row)).map(row => ({
    item_code: row.item_code, product_name: row.product_name, product_spec: row.product_spec || '',
    box_code: null, quantity: 1, batch_no: row.batch_no, factory_id: row.factory_id
  })) });
});

app.post('/api/factory/pack/pending-nobox', requireRole('admin', 'factory', 'brand', 'brand_staff'), receiptIntegrity.atomic((req, res) => {
  const itemCode = extractCode(req.body.item_code);
  const productId = Number(req.body.product_id);
  const requestedBatch = String(req.body.batch_no || '').trim();
  if (!itemCode || !productId) return res.status(400).json({ success: false, msg: '请先选择产品并扫描子码' });
  const product = scopedProduct(req, productId);
  if (!product || !brandInSet(brandScopeSet(req), product.brand_id)) return res.status(404).json({ success: false, msg: '产品不存在或未授权给当前工厂' });
  const item = db.prepare(`SELECT i.*,COALESCE(i.brand_id,p.brand_id) AS eff_brand_id
    FROM items i LEFT JOIN products p ON p.id=i.product_id WHERE i.item_code=?`).get(itemCode);
  if (!item || !brandInSet(brandScopeSet(req), item.eff_brand_id) || !factoryReceiptAllowed(req, item)) {
    return res.status(404).json({ success: false, msg: '子码不存在或不属于当前工厂' });
  }
  const owner = operationFactory(req, product, item);
  if (owner.error) return res.status(owner.error.includes('请选择') ? 400 : 403).json({ success: false, msg: owner.error });
  const batch = requestedBatch || product.batch_no || item.batch_no || '';
  if (!batch) return res.status(400).json({ success: false, msg: '请输入批次号' });
  if (item.box_id || item.boxed_at || item.status !== 'in_stock' || itemHasShipment(item)) {
    return res.status(409).json({ success: false, msg: '该子码已装箱、入库、发货或作废，不能加入清单' });
  }
  if ((item.eff_brand_id && Number(item.eff_brand_id) !== Number(product.brand_id)) ||
      (item.product_id && Number(item.product_id) !== Number(product.id)) ||
      (item.batch_no && item.batch_no !== batch)) {
    return res.status(409).json({ success: false, msg: '子码的品牌、产品或批次与所选资料不一致' });
  }
  const existing = db.prepare('SELECT * FROM factory_nobox_pending WHERE item_code=?').get(itemCode);
  if (existing) {
    const same = pendingNoBoxVisible(req, existing) && Number(existing.product_id) === Number(product.id) &&
      Number(existing.factory_id) === Number(owner.id) && existing.batch_no === batch;
    return res.status(same ? 200 : 409).json({ success: same, already_pending: same,
      msg: same ? '该子码已在待入库清单' : '该子码已在其他待入库清单，请勿重复扫描', item_code: itemCode });
  }
  const user = currentUser(req);
  const count = db.prepare(`SELECT COUNT(*) AS c FROM factory_nobox_pending WHERE ${user.role === 'factory' ? 'factory_id' : 'created_by'}=?`)
    .get(user.role === 'factory' ? user.factory_id : user.id).c;
  if (count >= 200) return res.status(400).json({ success: false, msg: '单次最多待确认 200 个子码，请先确认入库' });
  db.prepare(`INSERT INTO factory_nobox_pending
    (item_code,item_id,product_id,brand_id,factory_id,batch_no,created_by) VALUES (?,?,?,?,?,?,?)`)
    .run(itemCode, item.id, product.id, product.brand_id, owner.id, batch, user.id);
  res.json({ success: true, item_code: itemCode, product_name: product.name, product_spec: product.spec || '',
    batch_no: batch, msg: '已加入无箱码待入库清单，尚未计入库存' });
}));

app.delete('/api/factory/pack/pending-nobox/:code', requireRole('admin', 'factory', 'brand', 'brand_staff'), receiptIntegrity.atomic((req, res) => {
  const code = extractCode(req.params.code);
  const row = db.prepare('SELECT * FROM factory_nobox_pending WHERE item_code=?').get(code);
  if (!pendingNoBoxVisible(req, row)) return res.status(404).json({ success: false, msg: '待入库子码不存在或无权操作' });
  db.prepare('DELETE FROM factory_nobox_pending WHERE item_code=?').run(code);
  res.json({ success: true, msg: '已从待入库清单移除；库存未变更' });
}));

app.post('/api/factory/pack/confirm-nobox', requireRole('admin', 'factory', 'brand', 'brand_staff'), requireBrowserIdempotency, receiptIntegrity.atomic((req, res) => {
  const codes = [...new Set((Array.isArray(req.body.item_codes) ? req.body.item_codes : [])
    .map(code => extractCode(code)).filter(Boolean))];
  if (!codes.length || codes.length > 200) return res.status(400).json({ success: false, msg: '请选择 1 至 200 个待入库子码' });
  const toConfirm = [];
  for (const code of codes) {
    const row = db.prepare('SELECT * FROM factory_nobox_pending WHERE item_code=?').get(code);
    if (!pendingNoBoxVisible(req, row)) return res.status(404).json({ success: false, msg: `子码 ${code} 不在当前待入库清单` });
    const item = db.prepare('SELECT * FROM items WHERE id=? AND item_code=?').get(row.item_id, code);
    const product = db.prepare('SELECT * FROM products WHERE id=?').get(row.product_id);
    if (!item || !product || Number(product.brand_id) !== Number(row.brand_id) ||
        !factoryAssignedToProduct(row.factory_id, row.product_id) || !factoryReceiptAllowed(req, item) ||
        item.box_id || item.boxed_at || item.status !== 'in_stock' || itemHasShipment(item) ||
        (item.brand_id && Number(item.brand_id) !== Number(row.brand_id)) ||
        (item.product_id && Number(item.product_id) !== Number(row.product_id)) ||
        (item.batch_no && item.batch_no !== row.batch_no) ||
        (item.receipt_factory_id && Number(item.receipt_factory_id) !== Number(row.factory_id))) {
      return res.status(409).json({ success: false, msg: `子码 ${code} 状态或归属已变化，本次清单均未入库，请核对后移除冲突项` });
    }
    toConfirm.push({ row, item, product });
  }
  for (const { row, item, product } of toConfirm) {
    db.prepare(`UPDATE items SET product_id=?,brand_id=?,batch_no=?,receipt_factory_id=?,
      status='scanned',boxed_at=datetime('now','localtime') WHERE id=? AND status='in_stock'`)
      .run(row.product_id, row.brand_id, row.batch_no, row.factory_id, item.id);
    db.prepare('DELETE FROM factory_nobox_pending WHERE item_code=?').run(row.item_code);
    logPackRecord(req, 'nobox', null, row.item_code, product.name,
      `确认无箱码入库：${product.name} · 批次 ${row.batch_no}`, product.spec || '', 0, 1);
    logOperation(req, 'confirm_nobox_stock', 'item', row.item_code, `确认无箱码入库：${product.name}`);
  }
  res.json({ success: true, confirmed_count: toConfirm.length,
    msg: `已确认无箱码入库 ${toConfirm.length} 个子码`, item_codes: codes });
}));

// 旧客户端兼容接口：原有直接入库行为保留；新工厂页面只使用待确认清单。
// 无箱码直接扫子码入库：不扫箱码，直接把子码关联到产品+批次号，状态置为已入库（scanned）
// 适用于大包粮等无需装箱的单品（如 10kg 大包），直接扫子码完成产品绑定入库
app.post('/api/factory/pack/scan-nobox', requireRole('admin', 'factory', 'brand', 'brand_staff'), receiptIntegrity.atomic((req, res) => {
  const item_code = extractCode(req.body.item_code);
  const product_id = parseInt(req.body.product_id);
  const batch_no = (req.body.batch_no || '').trim();
  if (!item_code) return res.json({ success: false, msg: '请输入子码' });
  if (!product_id) return res.json({ success: false, msg: '请先选择产品' });

  const product = scopedProduct(req, product_id);
  if (!product) return res.status(404).json({ success: false, msg: '产品不存在或未授权给当前工厂' });

  const scopeSet = brandScopeSet(req);
  if (!brandInSet(scopeSet, product.brand_id)) return res.json({ success: false, msg: '该产品不属于你的品牌' });

  const item = db.prepare(`
    SELECT i.*, p.name as product_name, p.spec as product_spec, COALESCE(i.brand_id, p.brand_id) as eff_brand_id
    FROM items i LEFT JOIN products p ON i.product_id = p.id
    WHERE i.item_code = ?
  `).get(item_code);
  if (!item) return res.status(404).json({ success: false, code: 'ITEM_NOT_FOUND', msg: '子码不存在或无权访问' });
  if (!brandInSet(scopeSet, item.eff_brand_id)) return res.status(404).json({ success: false, code: 'ITEM_NOT_FOUND', msg: '子码不存在或无权访问' });
  if (db.prepare('SELECT 1 FROM factory_nobox_pending WHERE item_id=?').get(item.id)) return res.status(409).json({ success: false, msg: '该子码已在无箱码待入库清单，请先确认入库或移除' });
  if (!factoryReceiptAllowed(req, item)) return res.status(404).json({ success: false, code: 'RECEIPT_FACTORY_FORBIDDEN', msg: '子码不存在或不属于当前工厂' });
  const receiptOwner = operationFactory(req, product, item);
  if (receiptOwner.error) {
    return res.status(receiptOwner.error.includes('请选择') ? 400 : 403).json({ success: false, code: 'RECEIPT_FACTORY_REQUIRED', msg: receiptOwner.error });
  }
  if (itemHasShipment(item)) return res.json({ success: false, msg: '该子码已发货，不能入库' });
  if (item.status === 'invalid') return res.json({ success: false, msg: '该子码已作废，不能入库' });
  if (item.eff_brand_id && product.brand_id && item.eff_brand_id !== product.brand_id) return res.json({ success: false, msg: '子码与产品的品牌不一致，不能更改码的品牌归属' });

  // 防错1：已绑定箱码，走正常装箱流程，不能无箱码入库
  if (item.box_id) {
    const b = db.prepare('SELECT box_code FROM boxes WHERE id=?').get(item.box_id);
    return res.json({ success: false, msg: `该子码已绑定箱码 ${b?.box_code || ''}，请走正常装箱或先解绑`, bound_count: 0 });
  }
  // 防错2：已无箱码入库（重复扫）
  if (item.status === 'scanned') {
    return res.json({ success: false, msg: '该子码已入库（无箱码），请勿重复扫码', bound_count: 0 });
  }

  // 无箱码入库：关联产品 + 品牌 + 批次号，状态置为已入库 scanned；boxed_at 记录本次入库时间
  const effectiveBatch = batch_no || product.batch_no || item.batch_no || '';
  if (item.product_id && item.product_id !== product.id) return res.status(409).json({success:false,msg:'子码已指定其他产品，不能覆盖'});
  if (item.batch_no && item.batch_no !== effectiveBatch) return res.status(409).json({success:false,msg:'子码已指定其他批次，不能覆盖'});
  if (!effectiveBatch) return res.status(400).json({success:false,msg:'请输入批次号'});
  db.prepare("UPDATE items SET product_id=?, brand_id=COALESCE(?, brand_id), batch_no=?, status='scanned', boxed_at=datetime('now','localtime') WHERE id=?")
    .run(product.id, product.brand_id, effectiveBatch, item.id);
  db.prepare('UPDATE items SET receipt_factory_id=? WHERE id=?').run(receiptIntegrity.owner(req, product, item, receiptOwner.id), item.id);

  logPackRecord(req, 'nobox', null, item_code, product.name, `无箱码入库：${product.name}${product.spec ? '（'+product.spec+'）' : ''}${effectiveBatch ? ' · 批次 '+effectiveBatch : ''}`, product.spec, 0, 1);

  res.json({
    success: true,
    msg: `入库成功：${product.name}${product.spec ? '（'+product.spec+'）' : ''}`,
    item_code: item_code,
    product_name: product.name,
    product_spec: product.spec || '',
    batch_no: effectiveBatch
  });
}));

// 工厂装箱 · 扫码记录查询（工厂账号可查自己的装箱统计/明细）
app.get('/api/factory/pack/records', requireRole('admin', 'factory', 'brand', 'brand_staff'), (req, res) => {
  const u = req.session.user || {};
  const scopeSet = brandScopeSet(req);
  const scopeVals = scopeSet === null ? [] : brandSetValues(scopeSet);
  const scopePh = scopeVals.map(() => '?').join(',');
  const factoryId = u.factory_id || (parseInt(req.query.factory_id) || 0);
  const limit = Math.min(parseInt(req.query.limit) || 100, 500);
  if (u.role !== 'factory' && factoryId > 0) {
    const requestedFactory = db.prepare('SELECT id,brand_id FROM factories WHERE id=?').get(factoryId);
    if (!requestedFactory || !brandInSet(scopeSet, requestedFactory.brand_id)) {
      return res.status(404).json({ success: false, code: 'FACTORY_NOT_FOUND', msg: '工厂不存在或无权访问' });
    }
  }

  // 工厂账号：只看自己的记录；品牌/管理员：可看本品牌/全部
  let where = '1=1';
  const params = [];
  if (u.role === 'factory') {
    where = 'COALESCE(receipt_factory_id,factory_id) = ?';
    params.push(factoryId);
  } else if (factoryId > 0) {
    where = scopeSet === null
      ? 'COALESCE(receipt_factory_id,factory_id) = ?'
      : `brand_id IN (${scopePh}) AND COALESCE(receipt_factory_id,factory_id) = ?`;
    if (scopeSet !== null) params.push(...scopeVals);
    params.push(factoryId);
  } else if (scopeSet !== null) {
    where = `brand_id IN (${scopePh})`;
    params.push(...scopeVals);
  }

  // 明细
  const rows = db.prepare(
    `SELECT id, username, box_code, item_code, product_name, spec, box_size, item_count, action, detail, created_at
     FROM pack_records WHERE ${where} ORDER BY id DESC LIMIT ${limit}`
  ).all(...params);

  // 统计：装过哪些产品、扫多少码、装多少箱、扫错多少次
  const bindCount = db.prepare(`SELECT COUNT(*) c FROM pack_records WHERE ${where} AND
    (action IN ('bind','bind_pending','box_full_pending') OR (action='box_full' AND item_code IS NOT NULL))`).get(...params).c;
  const fullCount = db.prepare(`SELECT COUNT(*) c FROM pack_records WHERE ${where} AND action='box_full'`).get(...params).c;
  const noBoxCount = db.prepare(`SELECT COUNT(*) c FROM pack_records WHERE ${where} AND action='nobox'`).get(...params).c;
  const errCount = db.prepare(`SELECT COUNT(*) c FROM pack_records WHERE ${where} AND action='error'`).get(...params).c;
  const productStats = db.prepare(
    `SELECT product_name, spec, MAX(box_size) box_size, COUNT(*) c FROM pack_records WHERE ${where} AND action IN ('bind','box_full','nobox') AND product_name IS NOT NULL GROUP BY product_name ORDER BY c DESC`
  ).all(...params);

  res.json({
    success: true,
    stats: { scan_count: bindCount + noBoxCount, box_count: fullCount, error_count: errCount },
    products: productStats,
    records: rows
  });
});

// 工厂装箱汇总：按日期维度筛选，以产品名称为主导汇总，展示每款产品的入库箱数、产品总数，
// 以及每箱的箱码与子码明细。
app.get('/api/factory/pack/summary', requireRole('admin', 'factory', 'brand', 'brand_staff'), (req, res) => {
  const u = req.session.user || {};
  const scopeSet = brandScopeSet(req);
  const scopeVals = scopeSet === null ? [] : brandSetValues(scopeSet);
  const scopePh = scopeVals.map(() => '?').join(',');
  const factoryId = u.factory_id || (parseInt(req.query.factory_id) || 0);
  const date = (req.query.date || '').trim();
  if (u.role !== 'factory' && factoryId > 0) {
    const requestedFactory = db.prepare('SELECT id,brand_id FROM factories WHERE id=?').get(factoryId);
    if (!requestedFactory || !brandInSet(scopeSet, requestedFactory.brand_id)) {
      return res.status(404).json({ success: false, code: 'FACTORY_NOT_FOUND', msg: '工厂不存在或无权访问' });
    }
  }

  // 组装 boxes 上的筛选：品牌 + 实际收货工厂（receipt_factory_id）。
  // 业务日期口径：以「箱内子码的最后装箱时间（boxed_at）」为准，空箱回退箱码创建时间；
  // 取消绑定后重新装箱，会按重新装箱的时间归到业务日期，实现“当日入库实时联动”。
  const boxConds = ["b.status IN ('in_stock','shipped')", 'EXISTS (SELECT 1 FROM items current_item WHERE current_item.box_id=b.id)'];
  const boxParams = [];
  if (u.role === 'factory') {
    boxConds.push('b.receipt_factory_id = ?');
    boxParams.push(factoryId);
  } else if (factoryId > 0) {
    boxConds.push('b.receipt_factory_id = ?');
    boxParams.push(factoryId);
    if (Array.isArray(scopeSet) && scopeSet.length > 0) {
      boxConds.push(`COALESCE(b.brand_id, p.brand_id) IN (${scopePh})`);
      boxParams.push(...scopeVals);
    }
  } else if (Array.isArray(scopeSet) && scopeSet.length > 0) {
    boxConds.push(`COALESCE(b.brand_id, p.brand_id) IN (${scopePh})`);
    boxParams.push(...scopeVals);
  }
  const bizDateExpr = `COALESCE(
      (SELECT date(MAX(i.boxed_at)) FROM items i WHERE i.box_id = b.id AND i.boxed_at IS NOT NULL),
      date(b.created_at))`;
  if (date) {
    boxConds.push(`${bizDateExpr} = ?`);
    boxParams.push(date);
  }
  const boxWhere = boxConds.length ? boxConds.join(' AND ') : '1=1';

  // 可选日期列表（有装箱记录的日期，按业务日期倒序）
  const dateConds = [];
  const dateParams = [];
  if (u.role === 'factory') { dateConds.push('b.receipt_factory_id = ?'); dateParams.push(factoryId); }
  else if (factoryId > 0) {
    dateConds.push('b.receipt_factory_id = ?'); dateParams.push(factoryId);
    if (Array.isArray(scopeSet) && scopeSet.length > 0) { dateConds.push(`COALESCE(b.brand_id, p.brand_id) IN (${scopePh})`); dateParams.push(...scopeVals); }
  }
  else if (Array.isArray(scopeSet) && scopeSet.length > 0) { dateConds.push(`COALESCE(b.brand_id, p.brand_id) IN (${scopePh})`); dateParams.push(...scopeVals); }
  const dateWhere = dateConds.length ? 'AND ' + dateConds.join(' AND ') : '';
  const dateRows = db.prepare(
    `SELECT DISTINCT ${bizDateExpr} d
     FROM boxes b LEFT JOIN products p ON b.product_id = p.id
     WHERE b.product_id IS NOT NULL AND b.status IN ('in_stock','shipped') AND EXISTS (SELECT 1 FROM items current_item WHERE current_item.box_id=b.id) ${dateWhere}
     ORDER BY d DESC LIMIT 60`
  ).all(...dateParams);

  // 无箱码入库没有 boxes 记录，必须直接从当前已入库且未装箱的子码补入日期与汇总。
  // 这里读取 items 当前状态，取消入库后会实时从汇总消失；历史操作仍保留在 pack_records 明细中。
  const noBoxConds = ["i.box_id IS NULL", "i.status IN ('scanned','shipped')", 'i.boxed_at IS NOT NULL', 'i.product_id IS NOT NULL'];
  const noBoxParams = [];
  if (u.role === 'factory') {
    noBoxConds.push('i.receipt_factory_id = ?');
    noBoxParams.push(factoryId);
  } else if (factoryId > 0) {
    noBoxConds.push('i.receipt_factory_id = ?');
    noBoxParams.push(factoryId);
    if (Array.isArray(scopeSet) && scopeSet.length > 0) {
      noBoxConds.push(`COALESCE(i.brand_id, p.brand_id) IN (${scopePh})`);
      noBoxParams.push(...scopeVals);
    }
  } else if (Array.isArray(scopeSet) && scopeSet.length > 0) {
    noBoxConds.push(`COALESCE(i.brand_id, p.brand_id) IN (${scopePh})`);
    noBoxParams.push(...scopeVals);
  }
  const noBoxDateRows = db.prepare(
    `SELECT DISTINCT date(i.boxed_at) d
     FROM items i JOIN products p ON p.id=i.product_id
     WHERE ${noBoxConds.join(' AND ')}
     ORDER BY d DESC LIMIT 60`
  ).all(...noBoxParams);
  const dates = Array.from(new Set([...dateRows, ...noBoxDateRows].map(r => r.d).filter(Boolean)))
    .sort((a, b) => b.localeCompare(a)).slice(0, 60);

  // 装箱明细：所有已绑定产品的箱及其子码（附业务日期）
  const boxRows = db.prepare(
    `SELECT b.id, b.box_code, b.product_id, b.box_size, b.batch_no, b.created_at,
            ${bizDateExpr} AS biz_date,
            p.name AS product_name, p.spec AS spec, p.brand_id AS p_brand_id
     FROM boxes b
     LEFT JOIN products p ON b.product_id = p.id
     WHERE b.product_id IS NOT NULL AND ${boxWhere}
     ORDER BY ${bizDateExpr} ASC, b.id ASC`
  ).all(...boxParams);

  const filteredNoBoxConds = noBoxConds.slice();
  const filteredNoBoxParams = noBoxParams.slice();
  if (date) {
    filteredNoBoxConds.push('date(i.boxed_at) = ?');
    filteredNoBoxParams.push(date);
  }
  const noBoxRows = db.prepare(
    `SELECT i.id, i.item_code, i.product_id, i.batch_no, i.boxed_at,
            date(i.boxed_at) AS biz_date, p.name AS product_name, p.spec AS spec
     FROM items i JOIN products p ON p.id=i.product_id
     WHERE ${filteredNoBoxConds.join(' AND ')}
     ORDER BY i.boxed_at ASC, i.id ASC`
  ).all(...filteredNoBoxParams);

  // 子码明细：按箱收集
  const boxIds = boxRows.map(b => b.id);
  let itemByBox = {};
  if (boxIds.length) {
    const placeholders = boxIds.map(() => '?').join(',');
    const itemRows = db.prepare(
      `SELECT box_id, item_code FROM items WHERE box_id IN (${placeholders}) ORDER BY id ASC`
    ).all(...boxIds);
    itemRows.forEach(it => {
      (itemByBox[it.box_id] = itemByBox[it.box_id] || []).push(it.item_code);
    });
  }

  // 按产品汇总
  const byProduct = new Map();
  boxRows.forEach(b => {
    const key = `${b.product_id}`;
    if (!byProduct.has(key)) {
      byProduct.set(key, {
        product_id: b.product_id,
        product_name: b.product_name || '未命名',
        spec: b.spec || '',
        box_size: b.box_size || 0,
        box_count: 0,
        no_box_count: 0,
        item_count: 0,
        boxes: [],
        loose_items: []
      });
    }
    const entry = byProduct.get(key);
    const items = itemByBox[b.id] || [];
    entry.box_count += 1;
    entry.item_count += items.length;
    entry.boxes.push({
      box_code: b.box_code,
      batch_no: b.batch_no || '',
      box_size: b.box_size || 0,
      biz_date: b.biz_date || b.created_at,
      item_count: items.length,
      item_codes: items
    });
  });

  noBoxRows.forEach(item => {
    const key = `${item.product_id}`;
    if (!byProduct.has(key)) {
      byProduct.set(key, {
        product_id: item.product_id,
        product_name: item.product_name || '未命名',
        spec: item.spec || '',
        box_size: 0,
        box_count: 0,
        no_box_count: 0,
        item_count: 0,
        boxes: [],
        loose_items: []
      });
    }
    const entry = byProduct.get(key);
    entry.no_box_count += 1;
    entry.item_count += 1;
    entry.loose_items.push({
      item_code: item.item_code,
      batch_no: item.batch_no || '',
      biz_date: item.biz_date || item.boxed_at,
      boxed_at: item.boxed_at
    });
  });

  const summary = Array.from(byProduct.values())
    .sort((a, b) => b.item_count - a.item_count || a.product_name.localeCompare(b.product_name, 'zh'));

  const totalBoxes = summary.reduce((s, p) => s + p.box_count, 0);
  const totalNoBox = summary.reduce((s, p) => s + p.no_box_count, 0);
  const totalItems = summary.reduce((s, p) => s + p.item_count, 0);

  res.json({
    success: true,
    date: date || null,
    dates,
    total: { box_count: totalBoxes, no_box_count: totalNoBox, item_count: totalItems, product_count: summary.length },
    summary
  });
});

// --- 仓库发货 ---

// 发货核心：处理单个码（箱码→整箱，子码→散件），返回 { ok, msg, code, type, product_name, item_count }
// 不做 res 响应，纯逻辑，供单码/批量接口复用
// 代理商的品牌集合：多品牌匹配的代理商可以接收其中任一品牌的货。
// 兼容字段 distributors.brand_id 视为主品牌一并纳入，避免历史数据被误拦。
function distributorBrandIds(distributor) {
  return new Set(distributorBrandIdList(distributor));   // 与 distributorInScope 同一口径
}
function distributorBrandLabel(ids) {
  const list = [...ids];
  if (!list.length) return '未绑定品牌';
  const rows = db.prepare(`SELECT name FROM brands WHERE id IN (${list.map(() => '?').join(',')})`).all(...list);
  return rows.map(r => r.name).join('、') || ('ID ' + list.join('、'));
}
function shipOneCode(code, distributor_id, operator, scopeSet, distributor, order_no, remark) {
  code = extractCode(code);
  order_no = (order_no == null ? '' : String(order_no)).trim();
  remark = (remark == null ? '' : String(remark)).trim();
  if (!code) return { ok: false, msg: '请输入箱码或子码', code: '' };
  const distBrandIds = distributorBrandIds(distributor);

  // 先查箱码 → 整箱发货
  const box = db.prepare(`
    SELECT b.*, COALESCE(b.brand_id, p.brand_id) as eff_brand_id, p.name as product_name FROM boxes b LEFT JOIN products p ON b.product_id=p.id WHERE b.box_code=?
  `).get(code);
  if (box) {
    if (!brandInSet(scopeSet, box.eff_brand_id)) return { ok: false, msg: '箱码不存在或无权访问', code };
    if (!box.eff_brand_id || !distBrandIds.size || !distBrandIds.has(Number(box.eff_brand_id))) {
      return { ok: false, msg: '货物品牌与代理商品牌不一致，已阻止发货（代理商品牌：' + distributorBrandLabel(distBrandIds) + '）', code };
    }
    if (box.status === 'shipped') return { ok: false, msg: '该箱已发货，请勿重复发货', code };
    if (box.status === 'invalid') return { ok: false, msg: '该箱已作废，不能发货', code };
    if (box.status === 'packing') return { ok: false, msg: '该箱尚未确认入库，不能发货', code };
    const itemCount = db.prepare('SELECT COUNT(*) as c FROM items WHERE box_id=?').get(box.id).c;
    if (!box.product_id || itemCount === 0) return { ok: false, msg: '该箱尚未入库，不能发货', code };
    if (box.distributor_id != null || box.shipped_at || db.prepare('SELECT 1 FROM shipments WHERE box_id=? LIMIT 1').get(box.id)) return { ok: false, msg: '该箱或箱内子码已有发货记录，请先取消发货', code };
    const children = db.prepare('SELECT * FROM items WHERE box_id=?').all(box.id);
    if (children.some(child => child.status === 'invalid' || itemHasShipment(child))) return { ok: false, msg: '箱内有已发货或作废子码，不能整箱发货', code };
    const boxSize = Number(box.box_size) || 0;
    if (boxSize > 0 && itemCount < boxSize) {
      return { ok: false, msg: `该箱未装满，缺 ${boxSize - itemCount} 个子码（已扫 ${itemCount}/${boxSize}）`, code };
    }
    try {
      const tx = db.transaction(() => {
        db.prepare(`UPDATE boxes SET status=?, distributor_id=?, shipped_at=datetime('now','localtime') WHERE id=?`).run('shipped', distributor_id, box.id);
        db.prepare("UPDATE items SET status=?, distributor_id=?, shipped_at=datetime('now','localtime') WHERE box_id=?").run('shipped', distributor_id, box.id);
        db.prepare('INSERT INTO shipments (box_id, distributor_id, operator, order_no, remark) VALUES (?,?,?,?,?)').run(box.id, distributor_id, operator || '', order_no, remark);
      });
      tx();
    } catch (e) { return { ok: false, msg: '发货写入失败：' + e.message, code }; }
    return { ok: true, msg: `整箱发货成功（${itemCount}个产品）`, code, type: 'box', product_name: box.product_name || '', item_count: itemCount };
  }

  // 再查子码 → 散件发货
  const item = db.prepare(`
    SELECT i.*, COALESCE(i.brand_id, p.brand_id) as eff_brand_id, p.name as product_name,
      parent.status as parent_status, COALESCE(parent.brand_id, parent_product.brand_id) as parent_brand_id
    FROM items i
    LEFT JOIN products p ON i.product_id=p.id
    LEFT JOIN boxes parent ON parent.id=i.box_id
    LEFT JOIN products parent_product ON parent_product.id=parent.product_id
    WHERE i.item_code=?
  `).get(code);
  if (item) {
    if (!brandInSet(scopeSet, item.eff_brand_id)) return { ok: false, msg: '子码不存在或无权访问', code };
    if (!item.eff_brand_id || !distBrandIds.size || !distBrandIds.has(Number(item.eff_brand_id))) {
      return { ok: false, msg: '货物品牌与代理商品牌不一致，已阻止发货（代理商品牌：' + distributorBrandLabel(distBrandIds) + '）', code };
    }
    if (item.parent_status === 'invalid') return { ok: false, msg: '所属箱码已作废，箱内子码不能发货', code };
    if (item.parent_status === 'packing' || item.status === 'packing') return { ok: false, msg: '该子码尚未确认入库，不能发货', code };
    if (item.parent_brand_id && Number(item.parent_brand_id) !== Number(item.eff_brand_id)) {
      return { ok: false, msg: '子码与所属箱码品牌不一致，已阻止发货', code };
    }
    if (itemHasShipment(item)) return { ok: false, msg: '该子码已发货，请勿重复发货', code };
    if (item.status === 'invalid') return { ok: false, msg: '该子码已作废，不能发货', code };
    if (!item.product_id || (!item.box_id && !item.boxed_at)) return { ok: false, msg: '该子码尚未入库，不能发货', code };
    if (item.status === 'scanned' && item.box_id) {
      // 已扫码装箱的子码：散件发货同时要处理箱内扣除？这里保持原逻辑，仅按子码发货
    }
    try {
      const tx = db.transaction(() => {
        db.prepare(`UPDATE items SET status=?, distributor_id=?, shipped_at=datetime('now','localtime') WHERE id=?`).run('shipped', distributor_id, item.id);
        db.prepare('INSERT INTO shipments (box_id, distributor_id, operator, item_code, order_no, remark) VALUES (?,?,?,?,?,?)')
          .run(item.box_id || null, distributor_id, operator || '', code, order_no, remark);
      });
      tx();
    } catch (e) { return { ok: false, msg: '发货写入失败：' + e.message, code }; }
    return { ok: true, msg: '散件发货成功', code, type: 'item', product_name: item.product_name || '', item_count: 1 };
  }

  return { ok: false, msg: '码不存在，请核实是箱码还是子码', code };
}

// 扫码发货（单码，向后兼容）
// 扫码出库前查询码信息：返回商品名/数量/类型，供前端待发货清单展示
app.get('/api/warehouse/code-info', requireRole('admin', 'warehouse', 'brand'), (req, res) => {
  const code = extractCode(req.query.code || req.query.box_code || '');
  if (!code) return res.json({ success: false, msg: '请输入箱码或子码' });
  const scopeSet = brandScopeSet(req);
  // 先查箱码
  const box = db.prepare(`
    SELECT b.id, b.box_code, b.item_count, b.status, COALESCE(b.brand_id, p.brand_id) as eff_brand_id,
      p.name as product_name, p.spec as product_spec,
      (SELECT COUNT(*) FROM items i WHERE i.box_id=b.id) as real_item_count
    FROM boxes b LEFT JOIN products p ON b.product_id=p.id WHERE b.box_code=?
  `).get(code);
  if (box) {
    if (!brandInSet(scopeSet, box.eff_brand_id)) return res.json({ success: false, msg: '该码不属于你的品牌' });
    const childCodes = db.prepare(`SELECT i.item_code, COALESCE(i.brand_id, p.brand_id) AS eff_brand_id
      FROM items i LEFT JOIN products p ON p.id=i.product_id WHERE i.box_id=? ORDER BY i.id`).all(box.id)
      .filter(row => brandInSet(scopeSet, row.eff_brand_id)).map(row => row.item_code);
    return res.json({ success: true, type: 'box', code: box.box_code, product_name: box.product_name || '', product_spec: box.product_spec || '', quantity: box.real_item_count || box.item_count || 0, box_code: box.box_code, child_codes: childCodes });
  }
  // 再查子码
  const item = db.prepare(`
    SELECT i.id, i.item_code, i.status, COALESCE(i.brand_id, p.brand_id) as eff_brand_id,
      p.name as product_name, p.spec as product_spec, b.box_code as box_code
    FROM items i LEFT JOIN products p ON i.product_id=p.id LEFT JOIN boxes b ON b.id=i.box_id WHERE i.item_code=?
  `).get(code);
  if (item) {
    if (!brandInSet(scopeSet, item.eff_brand_id)) return res.json({ success: false, msg: '该码不属于你的品牌' });
    return res.json({ success: true, type: 'item', code: item.item_code, product_name: item.product_name || '', product_spec: item.product_spec || '', quantity: 1, box_code: item.box_code || '', bound_to_box: !!item.box_code });
  }
  return res.json({ success: false, msg: '码不存在，请核实是箱码还是子码' });
});

app.post('/api/shipments/ship', requireRole('admin', 'warehouse', 'brand'), (req, res) => {
  const code = extractCode(req.body.box_code || req.body.code);
  const distributor_id = req.body.distributor_id;
  const scopeSet = brandScopeSet(req);
  const operator = req.session.user.display_name || req.session.user.username;
  const order_no = req.body.order_no;
  const remark = req.body.remark;
  if (!code) return res.json({ success: false, msg: '请输入箱码或子码' });
  if (!distributor_id) return res.json({ success: false, msg: '请选择代理商' });
  const distributor = db.prepare('SELECT * FROM distributors WHERE id=?').get(distributor_id);
  if (!distributor) return res.json({ success: false, msg: '代理商不存在' });
  if (!distributorInScope(scopeSet, distributor)) return res.json({ success: false, msg: '该代理商不属于你的品牌' });

  const r = shipOneCode(code, distributor_id, operator, scopeSet, distributor, order_no, remark);
  if (!r.ok) return res.json({ success: false, msg: r.msg });
  res.json({ success: true, msg: `${r.msg} → ${distributor.name}（${distributor.region || ''}）` });
});

// 批量扫码发货：一次性提交多个码（箱码/子码混扫），统一发往同一代理商
app.post('/api/shipments/batch-ship', requireRole('admin', 'warehouse', 'brand'), (req, res) => {
  const codes = Array.isArray(req.body.codes) ? req.body.codes : [];
  const distributor_id = req.body.distributor_id;
  const order_no = req.body.order_no;
  const remark = req.body.remark;
  const scopeSet = brandScopeSet(req);
  const operator = req.session.user.display_name || req.session.user.username;
  if (!codes.length) return res.json({ success: false, msg: '请先扫码添加要发货的码' });
  if (!distributor_id) return res.json({ success: false, msg: '请选择代理商' });
  if (!order_no || !String(order_no).trim()) return res.json({ success: false, msg: '请先填写订单编号再扫码发货' });
  const distributor = db.prepare('SELECT * FROM distributors WHERE id=?').get(distributor_id);
  if (!distributor) return res.json({ success: false, msg: '代理商不存在' });
  if (!distributorInScope(scopeSet, distributor)) return res.json({ success: false, msg: '该代理商不属于你的品牌' });

  // 去重
  const uniqueCodes = [...new Set(codes.map(c => extractCode(c)).filter(Boolean))];
  // 母箱码与箱内子码不能在同一笔请求中混发；先整体校验，再写任何一条发货记录。
  const codeSet = new Set(uniqueCodes);
  const parentBoxOfItem = db.prepare('SELECT b.box_code FROM items i JOIN boxes b ON b.id=i.box_id WHERE i.item_code=?');
  const mixedItem = uniqueCodes.find(code => codeSet.has(parentBoxOfItem.get(code)?.box_code));
  if (mixedItem) {
    const msg = '同一清单同时包含箱码和该箱子码，请选择整箱发货或子码单件发货';
    return res.status(409).json({ success: false, partial_success: false, msg, shipped: [],
      failed: uniqueCodes.map(code => ({ code, msg })), total: uniqueCodes.length });
  }
  const successList = [];
  const failedList = [];
  for (const c of uniqueCodes) {
    const r = shipOneCode(c, distributor_id, operator, scopeSet, distributor, order_no, remark);
    if (r.ok) successList.push({ code: r.code, type: r.type, product_name: r.product_name, item_count: r.item_count });
    else failedList.push({ code: r.code, msg: r.msg });
  }
  res.json({
    success: successList.length > 0,
    partial_success: successList.length > 0 && failedList.length > 0,
    msg: `批量发货完成：成功 ${successList.length} 个，失败 ${failedList.length} 个`,
    shipped: successList,
    failed: failedList,
    total: uniqueCodes.length,
    distributor_name: distributor.name,
    distributor_region: distributor.region || ''
  });
});

// 取消发货：将已发货的箱码/子码回退为在库状态，并删除对应发货记录
app.post('/api/shipments/cancel', requireRole('admin', 'warehouse', 'brand'), (req, res) => {
  const code = extractCode(req.body.code || req.body.box_code || '');
  const scopeSet = brandScopeSet(req);
  const operator = req.session.user.display_name || req.session.user.username;
  if (!code) return res.json({ success: false, msg: '请输入要取消发货的箱码或子码' });

  // 先判断是箱码还是子码
  const box = db.prepare(`SELECT b.*, COALESCE(b.brand_id, p.brand_id) as eff_brand_id FROM boxes b LEFT JOIN products p ON b.product_id=p.id WHERE b.box_code=?`).get(code);
  if (box) {
    if (!brandInSet(scopeSet, box.eff_brand_id)) return res.json({ success: false, msg: '该箱码不存在或无权访问' });
    if (box.status === 'invalid') return res.json({ success: false, msg: '该箱码已作废，不能取消发货' });
    const boxShipment = db.prepare('SELECT 1 FROM shipments WHERE box_id=? LIMIT 1').get(box.id);
    if (box.status !== 'shipped' && box.distributor_id == null && !box.shipped_at && !boxShipment) return res.json({ success: false, msg: '该箱及其子码均无发货记录，无需取消' });
    const tx = db.transaction(() => {
      db.prepare("UPDATE boxes SET status='in_stock', distributor_id=NULL, shipped_at=NULL WHERE id=?").run(box.id);
      // 箱级撤销覆盖整箱发货与箱内子码单件发货；只恢复确实属于本箱的有效子码。
      db.prepare("UPDATE items SET status='scanned', distributor_id=NULL, shipped_at=NULL WHERE box_id=? AND status!='invalid'").run(box.id);
      db.prepare('DELETE FROM shipments WHERE box_id=?').run(box.id);
    });
    tx();
    logOperation(req, 'cancel_ship', 'box', box.box_code, `取消发货：箱码「${box.box_code}」`);
    return res.json({ success: true, msg: `已取消发货：箱码 ${box.box_code}` });
  }

  const item = db.prepare(`SELECT i.*, COALESCE(i.brand_id, p.brand_id) as eff_brand_id FROM items i LEFT JOIN products p ON i.product_id=p.id WHERE i.item_code=?`).get(code);
  if (!item) return res.json({ success: false, msg: '码不存在，请核实是箱码还是子码' });
  if (!brandInSet(scopeSet, item.eff_brand_id)) return res.json({ success: false, msg: '该子码不存在或无权访问' });
  if (item.status === 'invalid') return res.json({ success: false, msg: '该子码已作废，不能取消发货' });
  if (!itemHasShipment(item)) return res.json({ success: false, msg: '该子码未发货，无需取消' });
  if (item.box_id && db.prepare("SELECT 1 FROM shipments WHERE box_id=? AND (item_code IS NULL OR item_code='') LIMIT 1").get(item.box_id)) return res.json({ success: false, msg: '该子码随整箱发货，请扫描箱码取消整箱发货' });
  const tx = db.transaction(() => {
    db.prepare("UPDATE items SET status=?, distributor_id=NULL, shipped_at=NULL WHERE id=?").run(item.box_id || item.boxed_at ? 'scanned' : 'in_stock', item.id);
    db.prepare('DELETE FROM shipments WHERE item_code=?').run(item.item_code);
  });
  tx();
  logOperation(req, 'cancel_ship', 'item', item.item_code, `取消发货：子码「${item.item_code}」`);
  return res.json({ success: true, msg: `已取消发货：子码 ${item.item_code}` });
});

// 所有撤销入口共用：保留品牌所有权，商品/批次等本次入库关联写入历史后清空。
function itemHasShipment(item) {
  return item.status === 'shipped' || item.distributor_id != null || !!item.shipped_at ||
    !!db.prepare('SELECT 1 FROM shipments WHERE item_code=? LIMIT 1').get(item.item_code) ||
    !!(item.box_id && db.prepare("SELECT 1 FROM boxes WHERE id=? AND (status='shipped' OR distributor_id IS NOT NULL OR shipped_at IS NOT NULL)").get(item.box_id));
}
function receiptAudit(req, targetType, targetId, snapshot) {
  const u = req.session.user;
  db.prepare(`INSERT INTO operation_logs (user_id,username,role,action,target_type,target_id,detail,brand_id)
    VALUES (?,?,?,'receipt_binding_cleared',?,?,?,?)`).run(u.id, u.username, u.role, targetType, targetId,
      JSON.stringify(snapshot), snapshot.brand_id || u.brand_id || null);
}
function clearItemReceipt(req, item) {
  logPackRecord(req, item.box_id ? 'unbind' : 'nobox_cancel',
    item.box_id ? db.prepare('SELECT box_code FROM boxes WHERE id=?').get(item.box_id)?.box_code : null,
    item.item_code, null, '取消入库，历史商品和批次已保留', null, 0, 0);
  receiptAudit(req, 'item', item.item_code, { product_id: item.product_id, batch_no: item.batch_no,
    box_id: item.box_id, brand_id: item.eff_brand_id || item.brand_id, boxed_at: item.boxed_at });
  db.prepare(`UPDATE items SET brand_id=COALESCE(brand_id,(SELECT brand_id FROM products WHERE id=items.product_id)),
    box_id=NULL, product_id=NULL, batch_no='', status='in_stock', boxed_at=NULL, receipt_factory_id=NULL,
    distributor_id=NULL, shipped_at=NULL WHERE id=?`).run(item.id);
}
function clearBoxReceipt(req, box) {
  receiptAudit(req, 'box', box.box_code, { product_id: box.product_id, batch_no: box.batch_no,
    box_size: box.box_size, brand_id: box.eff_brand_id || box.brand_id });
  db.prepare(`UPDATE boxes SET brand_id=COALESCE(brand_id,(SELECT brand_id FROM products WHERE id=boxes.product_id)),
    product_id=NULL, batch_no='', box_size=0, item_count=0, status='in_stock', receipt_factory_id=NULL,
    distributor_id=NULL, shipped_at=NULL WHERE id=?`).run(box.id);
}

// 取消入库：撤销当前商品关联；历史仍在操作日志、扫码记录中保留。
app.post('/api/codes/cancel-stock', requireRole('admin', 'factory', 'brand', 'brand_staff'), receiptIntegrity.atomic((req, res) => {
  const code = extractCode(req.body.code || req.body.item_code || '');
  const expectedMode = req.body.expected_mode === 'nobox' ? 'nobox' : req.body.expected_mode === 'boxed' ? 'boxed' : '';
  const scopeSet = brandScopeSet(req);
  if (!code) return res.json({ success: false, msg: '请输入要取消入库的箱码或子码' });

  // 箱码：整箱取消入库（箱内子码全部解绑）
  const box = db.prepare(`SELECT b.*, COALESCE(b.brand_id, p.brand_id) as eff_brand_id FROM boxes b LEFT JOIN products p ON b.product_id=p.id WHERE b.box_code=?`).get(code);
  if (box) {
    if (expectedMode === 'nobox') return res.json({ success: false, msg: '这是箱码，请使用「箱码/装箱子码取消入库」入口' });
    if (!brandInSet(scopeSet, box.eff_brand_id)) return res.json({ success: false, msg: '该箱码不存在或无权访问' });
    if (!factoryReceiptAllowed(req, box)) return res.status(404).json({ success: false, code: 'RECEIPT_FACTORY_FORBIDDEN', msg: '该箱码不存在或不属于当前工厂' });
    if (box.status === 'invalid') return res.json({ success: false, msg: '该箱码已作废，不能取消入库' });
    if (box.status === 'shipped' || box.distributor_id != null || box.shipped_at || db.prepare('SELECT 1 FROM shipments WHERE box_id=? LIMIT 1').get(box.id)) return res.json({ success: false, msg: '该箱已发货，请先「取消发货」再取消入库' });
    const children = db.prepare('SELECT * FROM items WHERE box_id=?').all(box.id);
    if (children.some(item => !factoryReceiptAllowed(req, item))) {
      return res.status(409).json({ success: false, code: 'RECEIPT_FACTORY_CONFLICT', msg: '箱内存在其他工厂的子码，不能整箱取消入库' });
    }
    if (children.some(itemHasShipment)) return res.json({ success: false, msg: '箱内子码已发货，请先取消发货' });
    if (children.some(item => item.status === 'invalid')) return res.json({ success: false, msg: '箱内包含作废子码，不能取消入库' });
    if (!box.product_id && children.length === 0) return res.json({ success: false, msg: '该箱码尚未入库，无需取消' });
    const tx = db.transaction(() => {
      for (const child of children) clearItemReceipt(req, child);
      clearBoxReceipt(req, box);
    });
    tx();
    logOperation(req, 'cancel_stock', 'box', box.box_code, `取消入库：箱码「${box.box_code}」整箱子码解绑`);
    return res.json({ success: true, msg: `已取消入库：箱码 ${box.box_code} 下的子码全部解绑` });
  }

  // 子码：单个取消入库（解绑）
  const item = db.prepare(`SELECT i.*, COALESCE(i.brand_id, p.brand_id) as eff_brand_id,
    p.name as product_name, p.spec as product_spec
    FROM items i LEFT JOIN products p ON i.product_id=p.id WHERE i.item_code=?`).get(code);
  if (!item) return res.json({ success: false, msg: '码不存在，请核实是箱码还是子码' });
  if (!brandInSet(scopeSet, item.eff_brand_id)) return res.json({ success: false, msg: '该子码不存在或无权访问' });
  if (!factoryReceiptAllowed(req, item)) return res.status(404).json({ success: false, code: 'RECEIPT_FACTORY_FORBIDDEN', msg: '该子码不存在或不属于当前工厂' });
  if (item.status === 'invalid') return res.json({ success: false, msg: '该子码已作废，不能取消入库' });
  if (itemHasShipment(item)) return res.json({ success: false, msg: '该子码已发货，请先「取消发货」再取消入库' });
  const isNoBoxReceipt = !item.box_id && item.status === 'scanned' && !!item.boxed_at && !!item.product_id;
  if (expectedMode === 'nobox' && !isNoBoxReceipt) {
    return res.json({ success: false, msg: item.box_id ? '该子码已装箱，请使用「箱码/装箱子码取消入库」入口' : '该子码不是无箱码已入库状态，无需取消' });
  }
  if (expectedMode === 'boxed' && isNoBoxReceipt) {
    return res.json({ success: false, msg: '这是无箱码已入库子码，请使用「无箱码子码取消入库」入口' });
  }
  if (!item.box_id && !isNoBoxReceipt) return res.json({ success: false, msg: '该子码尚未入库，无需取消入库' });

  const boxId = item.box_id;
  const tx = db.transaction(() => {
    clearItemReceipt(req, item);
    if (boxId) {
      const count = db.prepare('SELECT COUNT(*) as c FROM items WHERE box_id=?').get(boxId).c;
      db.prepare('UPDATE boxes SET item_count=? WHERE id=?').run(count, boxId);
      if (count === 0) clearBoxReceipt(req, db.prepare('SELECT * FROM boxes WHERE id=?').get(boxId));
    }
  });
  tx();
  logOperation(req, 'cancel_stock', 'item', item.item_code, `取消入库：子码「${item.item_code}」解绑`);
  if (isNoBoxReceipt) {
    return res.json({ success: true, mode: 'nobox', msg: `已取消无箱码入库：子码 ${item.item_code} 已回到在库状态` });
  }
  return res.json({ success: true, mode: 'boxed', msg: `已取消入库：子码 ${item.item_code} 已解绑` });
}));

// 取消操作响应丢失时只读核对最终状态；不推断是哪一次请求完成了操作。
app.get('/api/codes/reversal-state', requireRole('admin', 'factory', 'brand', 'brand_staff', 'warehouse'), (req, res) => {
  const kind = req.query.kind === 'stock' ? 'stock' : req.query.kind === 'shipment' ? 'shipment' : '';
  const role = currentUser(req)?.role;
  if (!kind) return res.status(400).json({ success: false, msg: '请选择核对类型' });
  if (kind === 'stock' && !['admin', 'factory', 'brand', 'brand_staff'].includes(role)) return res.status(403).json({ success: false, msg: '无权核对入库状态' });
  if (kind === 'shipment' && !['admin', 'warehouse', 'brand'].includes(role)) return res.status(403).json({ success: false, msg: '无权核对发货状态' });
  const code = extractCode(req.query.code || '');
  if (!code) return res.status(400).json({ success: false, msg: '请输入箱码或子码' });
  const scopeSet = brandScopeSet(req);
  const isFactory = currentUser(req)?.role === 'factory';
  const factory = isFactory ? Number(currentUser(req).factory_id) : null;
  const factoryMayCheck = (receipt, codeColumn) => {
    if (!isFactory) return true;
    if (!factory) return false;
    if (receipt.receipt_factory_id || receipt.product_id) return factoryReceiptAllowed(req, receipt);
    const history = db.prepare(`SELECT receipt_factory_id FROM pack_records WHERE ${codeColumn}=? AND receipt_factory_id IS NOT NULL ORDER BY id DESC LIMIT 1`).get(code);
    return Number(history?.receipt_factory_id) === factory;
  };
  const box = db.prepare(`SELECT b.*, COALESCE(b.brand_id,p.brand_id) AS eff_brand_id
    FROM boxes b LEFT JOIN products p ON p.id=b.product_id WHERE b.box_code=?`).get(code);
  if (box) {
    if (!brandInSet(scopeSet, box.eff_brand_id) || (kind === 'stock' && !factoryMayCheck(box, 'box_code'))) return res.status(404).json({ success: false, msg: '码不存在或无权核对' });
    const childCount = db.prepare('SELECT COUNT(*) AS c FROM items WHERE box_id=?').get(box.id).c;
    const hasShipment = box.status === 'shipped' || box.distributor_id != null || !!box.shipped_at ||
      !!db.prepare('SELECT 1 FROM shipments WHERE box_id=? LIMIT 1').get(box.id);
    const settled = box.status !== 'invalid' && (kind === 'stock'
      ? box.status === 'in_stock' && !box.product_id && !box.receipt_factory_id && childCount === 0
      : !hasShipment);
    return res.json({ success: true, code, kind, settled, state: settled ? '已无对应业务关联' : '仍有对应业务关联' });
  }
  const item = db.prepare(`SELECT i.*, COALESCE(i.brand_id,p.brand_id) AS eff_brand_id
    FROM items i LEFT JOIN products p ON p.id=i.product_id WHERE i.item_code=?`).get(code);
  if (!item || !brandInSet(scopeSet, item.eff_brand_id) || (kind === 'stock' && !factoryMayCheck(item, 'item_code'))) return res.status(404).json({ success: false, msg: '码不存在或无权核对' });
  const settled = item.status !== 'invalid' && (kind === 'stock'
    ? item.status === 'in_stock' && !item.box_id && !item.product_id && !item.boxed_at && !item.receipt_factory_id
    : !itemHasShipment(item));
  res.json({ success: true, code, kind, settled, state: settled ? '已无对应业务关联' : '仍有对应业务关联' });
});

// 查询条件按字面匹配：把 LIKE 的通配符转义掉（配合 ESCAPE '\\' 使用）
function likeLiteral(value) {
  return String(value == null ? '' : value).replace(/[\\%_]/g, ch => `\\${ch}`);
}

// 获取发货记录（brand 只看自己品牌）
app.get('/api/shipments', requireRole('admin', 'warehouse', 'brand'), (req, res) => {
  const scopeSet = brandScopeSet(req);
  const date = (req.query.date || '').trim();   // 可选：按日期过滤 YYYY-MM-DD
  const order_no = (req.query.order_no || '').trim();      // 订单编号（模糊）
  const distributor_id = (req.query.distributor_id || '').trim(); // 代理商 id
  const code = (req.query.code || '').trim();              // 兼容旧参数：箱码或子码（模糊）
  const box_code = (req.query.box_code || '').trim();      // 箱码（模糊）
  const item_code = (req.query.item_code || '').trim();    // 子码/字码（模糊）
  const remark = (req.query.remark || '').trim();          // 备注（模糊）
  // 品牌过滤：优先按**货物**品牌；货物品牌缺失时才回落到代理商，且回落时按
  // 「代理商的任一品牌」判定（兼容单字段会让多品牌代理商的记录在别的品牌范围里看不见）。
  let brandFilter = scopeSet === null ? '' : ` WHERE (
      COALESCE(p_box.brand_id, p_item.brand_id) IN (${brandSetValues(scopeSet).map(() => '?').join(',')})
      OR (COALESCE(p_box.brand_id, p_item.brand_id) IS NULL
          AND (SELECT COUNT(*) FROM (
                 SELECT d.brand_id AS bid
                 UNION SELECT dz.brand_id FROM distributor_brands dz WHERE dz.distributor_id=d.id
               ) q WHERE q.bid IN (${brandSetValues(scopeSet).map(() => '?').join(',')})) > 0)
    )`;
  const params = scopeSet === null ? [] : [...brandSetValues(scopeSet), ...brandSetValues(scopeSet)];
  const pushFilter = (cond) => { brandFilter += (brandFilter ? ' AND' : ' WHERE') + cond; };
  if (date) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      pushFilter(" date(s.shipped_at)=?");
      params.push(date);
    } else {
      return res.json({ success: false, msg: '日期格式错误，应为 YYYY-MM-DD' });
    }
  }
  if (order_no) { pushFilter(" s.order_no LIKE ? ESCAPE '\\'"); params.push(`%${likeLiteral(order_no)}%`); }
  if (distributor_id) { pushFilter(' s.distributor_id=?'); params.push(parseInt(distributor_id) || 0); }
  if (code) {
    pushFilter(" (b.box_code LIKE ? ESCAPE '\\' OR s.item_code LIKE ? ESCAPE '\\')");
    params.push(`%${likeLiteral(code)}%`, `%${likeLiteral(code)}%`);
  }
  if (box_code) { pushFilter(" b.box_code LIKE ? ESCAPE '\\'"); params.push(`%${likeLiteral(box_code)}%`); }
  if (item_code) { pushFilter(" s.item_code LIKE ? ESCAPE '\\'"); params.push(`%${likeLiteral(item_code)}%`); }
  if (remark) { pushFilter(" s.remark LIKE ? ESCAPE '\\'"); params.push(`%${likeLiteral(remark)}%`); }
  const shipments = db.prepare(`
    SELECT s.*,
      b.box_code, b.item_count,
      COALESCE(p_box.name, p_item.name) as product_name,
      COALESCE(p_box.spec, p_item.spec) as product_spec,
      d.name as distributor_name, d.region as distributor_region,
      COALESCE(b.batch_no, i.batch_no) as batch_no,
      CASE WHEN s.item_code IS NOT NULL AND s.item_code != '' THEN 1 ELSE COALESCE(b.item_count, 0) END as product_qty,
      CASE WHEN s.item_code IS NOT NULL AND s.item_code != '' THEN 0 ELSE 1 END as box_qty
    FROM shipments s
    LEFT JOIN boxes b ON s.box_id = b.id
    LEFT JOIN items i ON s.item_code = i.item_code
    LEFT JOIN products p_box ON b.product_id = p_box.id
    LEFT JOIN products p_item ON i.product_id = p_item.id
    LEFT JOIN distributors d ON s.distributor_id = d.id
    ${brandFilter}
    ORDER BY s.shipped_at DESC
    LIMIT 500
  `).all(...params);

  // 需求 #6: 按「订单编号」聚合，同一订单下的所有产品合并显示
  // 为实现「订单 → 产品 → 箱 → 子码」逐级追溯，补充：整箱发货查箱内每个子码
  const boxIds = shipments.map(s => s.box_id).filter(id => id != null);
  let itemsByBox = {};
  if (boxIds.length) {
    const ph = boxIds.map(() => '?').join(',');
    const itemRows = db.prepare(
      `SELECT box_id, item_code FROM items WHERE box_id IN (${ph}) ORDER BY id ASC`
    ).all(...boxIds);
    itemRows.forEach(it => {
      (itemsByBox[it.box_id] = itemsByBox[it.box_id] || []).push(it.item_code);
    });
  }

  // 按订单编号聚合（同一 order_no 的所有产品、代理商合并）
  const groupsMap = new Map();
  for (const s of shipments) {
    const orderKey = s.order_no || '_无订单_' + (s.id || Math.random());
    if (!groupsMap.has(orderKey)) {
      groupsMap.set(orderKey, {
        order_no: s.order_no || '',
        distributor_name: s.distributor_name || '',
        distributor_region: s.distributor_region || '',
        operator: s.operator || '',
        shipped_at: s.shipped_at || '',
        remark: s.remark || '',
        total_product_qty: 0,
        total_box_qty: 0,
        product_count: 0,
        // 订单下每个产品单独一条明细
        items: [],
        // 全部码值（用于查看码值按钮）
        all_codes: [],
        all_boxes: [],
        all_loose_items: []
      });
    }
    const g = groupsMap.get(orderKey);
    g.total_product_qty += s.product_qty || 0;
    g.total_box_qty += s.box_qty || 0;

    // 按产品名称分组
    const productName = s.product_name || '未命名产品';
    let productEntry = g.items.find(p => p.product_name === productName && p.product_spec === (s.product_spec || ''));
    if (!productEntry) {
      productEntry = {
        product_name: productName,
        product_spec: s.product_spec || '',
        batch_no: s.batch_no || '',
        product_qty: 0,
        box_qty: 0,
        codes: [],
        boxes: [],
        loose_items: []
      };
      g.items.push(productEntry);
      g.product_count++;
    }
    productEntry.product_qty += s.product_qty || 0;
    productEntry.box_qty += s.box_qty || 0;

    if (s.item_code) {
      productEntry.codes.push({ code: s.item_code, type: 'item' });
      productEntry.loose_items.push({ item_code: s.item_code });
      g.all_codes.push({ code: s.item_code, type: 'item' });
      g.all_loose_items.push({ item_code: s.item_code });
    } else if (s.box_code) {
      const itemCodes = itemsByBox[s.box_id] || [];
      productEntry.codes.push({ code: s.box_code, type: 'box' });
      productEntry.boxes.push({ box_code: s.box_code, item_count: itemCodes.length, item_codes: itemCodes });
      g.all_codes.push({ code: s.box_code, type: 'box' });
      g.all_boxes.push({ box_code: s.box_code, item_count: itemCodes.length, item_codes: itemCodes });
    }
  }
  const groups = Array.from(groupsMap.values());

  res.json({ success: true, shipments, groups });
});

// --- 消费者验证 ---

function normalizeLocation(value) {
  return String(value || '').replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 120);
}

// IP → 地区（省级+市级），用于串货自动判定（消费者扫码时无需手动填位置）
// 使用 ip2region 离线库（本地 xdb 数据，覆盖国内 IP，无外部网络依赖，不会拖垮服务）
const ipRegionCache = new Map();
const IP_REGION_CACHE_MAX = 10000;

function ipToRegion(ip) {
  if (!ip) return '';
  const ipStr = String(ip).replace(/^::ffff:/, '').trim();
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ipStr)) return '';
  if (/^(10\.|127\.|0\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ipStr)) return '';
  if (ipRegionCache.has(ipStr)) return ipRegionCache.get(ipStr);
  let region = '';
  try {
    region = require('./ip2region').ipRegionName(ipStr);
  } catch (e) {
    region = '';
  }
  if (ipRegionCache.size >= IP_REGION_CACHE_MAX) ipRegionCache.clear();
  ipRegionCache.set(ipStr, region);
  return region;
}

function publicRegion(value) {
  const location = normalizeLocation(value);
  if (!location) return '';
  const province = location.match(/^(.{2,12}?(?:省|自治区|特别行政区))/);
  if (province) return province[1];
  const city = location.match(/^(.{2,8}?市)/);
  if (city) return city[1];
  return location.length <= 2 ? location : `${location.slice(0, 2)}***`;
}

const VERIFY_WINDOW_MS = 60 * 1000;
const VERIFY_MAX_ATTEMPTS = 60;
db.exec(`
  CREATE TABLE IF NOT EXISTS verification_rate_limits (
    source_hash TEXT PRIMARY KEY,
    attempt_count INTEGER NOT NULL,
    reset_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_verification_rate_limits_reset_at ON verification_rate_limits(reset_at);
`);
const readVerificationLimit = db.prepare('SELECT attempt_count, reset_at FROM verification_rate_limits WHERE source_hash=?');
const writeVerificationLimit = db.prepare(`
  INSERT INTO verification_rate_limits (source_hash, attempt_count, reset_at, updated_at) VALUES (?, ?, ?, ?)
  ON CONFLICT(source_hash) DO UPDATE SET attempt_count=excluded.attempt_count, reset_at=excluded.reset_at, updated_at=excluded.updated_at
`);
const cleanupVerificationLimits = db.prepare('DELETE FROM verification_rate_limits WHERE reset_at<=?');
const recordVerificationAttempt = db.transaction((sourceHash, now) => {
  cleanupVerificationLimits.run(now);
  const current = readVerificationLimit.get(sourceHash);
  const attemptCount = current && current.reset_at > now ? current.attempt_count + 1 : 1;
  const resetAt = current && current.reset_at > now ? current.reset_at : now + VERIFY_WINDOW_MS;
  writeVerificationLimit.run(sourceHash, attemptCount, resetAt, now);
  return { attemptCount, resetAt };
});
function verificationRateLimit(req, res, next) {
  const now = Date.now();
  const sourceHash = crypto.createHmac('sha256', SESSION_SECRET)
    .update(`verify:${String(req.ip || req.socket.remoteAddress || 'unknown')}`)
    .digest('hex');
  const limit = recordVerificationAttempt(sourceHash, now);
  if (limit.attemptCount > VERIFY_MAX_ATTEMPTS) {
    res.setHeader('Retry-After', String(Math.max(1, Math.ceil((limit.resetAt - now) / 1000))));
    return res.status(429).json({ success: false, code: 'VERIFY_RATE_LIMITED', msg: '查询过于频繁，请稍后再试' });
  }
  next();
}

// 验证码
app.get('/api/verify/:code', verificationRateLimit, wrap(async (req, res) => {
  const code = extractCode(req.params.code);
  const scanIp = req.ip || req.connection?.remoteAddress || '';
  const sourceId = scanSourceId(scanIp);
  const lat = parseFloat(req.query.lat);
  const lng = parseFloat(req.query.lng);
  const latitude = Number.isFinite(lat) && lat >= -90 && lat <= 90 ? lat : null;
  const longitude = Number.isFinite(lng) && lng >= -180 && lng <= 180 ? lng : null;

  // 串货判定位置：优先消费者主动填写的区域；为空时用 IP 自动定位（消费者无感）
  let scanLocation = normalizeLocation(req.query.location);
  if (!scanLocation) {
    scanLocation = ipToRegion(scanIp);
  }

  // 该码历史扫码信息（用于多次扫码提醒）
  const historyCount = db.prepare('SELECT COUNT(*) as c FROM scan_logs WHERE item_code=?').get(code).c;
  const firstScan = db.prepare(`
    SELECT scanned_at, scan_location FROM scan_logs
    WHERE item_code=? ORDER BY id ASC LIMIT 1
  `).get(code);

  // 先查箱码
  const brandName = db.prepare("SELECT value FROM settings WHERE key='brand_name'").get()?.value || '';
  let box = db.prepare(`
    SELECT b.*, p.name as product_name, p.spec as product_spec, p.brand_id as product_brand_id,
      COALESCE(b.brand_id, p.brand_id) as eff_brand_id, br.name as tenant_brand_name,
      d.name as distributor_name, d.region as distributor_region, d.covered_regions as distributor_covered_regions,
      d.brand_id as distributor_brand_id,
      -- 代理商与货物品牌是否真的不匹配：代理商匹配的品牌集合里没有它，且兼容单字段也不等于它。
      -- 只看兼容字段（旧写法）会把「多品牌代理商的合法发货」误判成资料冲突。
      CASE WHEN d.id IS NULL THEN 0
        WHEN EXISTS (SELECT 1 FROM distributor_brands dbr WHERE dbr.distributor_id=d.id AND dbr.brand_id=COALESCE(b.brand_id,p.brand_id)) THEN 0
        WHEN d.brand_id IS NOT COALESCE(b.brand_id,p.brand_id) THEN 1
        ELSE 0 END AS distributor_brand_mismatch
    FROM boxes b
    LEFT JOIN products p ON b.product_id = p.id
    LEFT JOIN brands br ON br.id = COALESCE(b.brand_id, p.brand_id)
    LEFT JOIN distributors d ON b.distributor_id = d.id
    WHERE b.box_code = ?
  `).get(code);

  if (box) {
    const boxBrandConflict = (box.product_id && (!box.product_brand_id || (box.brand_id && Number(box.brand_id) !== Number(box.product_brand_id)))) ||
      (box.distributor_id && Number(box.distributor_brand_mismatch) === 1);
    const childConflict = db.prepare(`SELECT COUNT(*) c FROM items i LEFT JOIN products ip ON ip.id=i.product_id
      WHERE i.box_id=? AND (i.product_id IS NOT ? OR COALESCE(i.brand_id,ip.brand_id) IS NOT ? OR COALESCE(i.batch_no,'')<>COALESCE(?,'') )`)
      .get(box.id, box.product_id, box.eff_brand_id, box.batch_no).c;
    if (boxBrandConflict || childConflict > 0) {
      return res.status(409).json({ success: false, code: 'CODE_DATA_CONFLICT', msg: '该码的品牌、产品或批次资料存在历史冲突，已暂停公开展示，请联系品牌方核对原始生产资料' });
    }
    const publicContent = box.product_id && box.eff_brand_id ? productContent(box.product_id, box.eff_brand_id, box.batch_no, false) : { media: [], batch: null, trace: [], marketing: null };
    const itemSummary = db.prepare(`SELECT COUNT(*) as item_count,
      SUM(CASE WHEN scanned_at IS NOT NULL THEN 1 ELSE 0 END) as verified_count FROM items WHERE box_id=?`).get(box.id);
    const isShipped = box.status === 'shipped';
    // 记录扫码日志（含分级 + 品牌归属）
    let isDiversion = 0;
    if (isShipped) {
      isDiversion = detectDiversion(box.distributor_region, scanLocation, box.distributor_covered_regions);
    }
    db.prepare(`INSERT INTO scan_logs (item_code, box_code, product_name, distributor_name, assigned_region, scan_location, scan_ip, is_diversion, latitude, longitude, brand_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(code, code, box.product_name, box.distributor_name || '', box.distributor_region || '', scanLocation, sourceId, isDiversion, latitude, longitude, box.eff_brand_id || null);
    // 串货预警：自动进入预警中心
    if (isDiversion > 0) {
      db.prepare(`INSERT INTO alerts (item_code, box_code, product_name, distributor_name, assigned_region, scan_location, level, brand_id)
        VALUES (?,?,?,?,?,?,?,?)`).run(code, code, box.product_name || '', box.distributor_name || '', box.distributor_region || '', scanLocation, isDiversion, box.eff_brand_id || null);
    }

    return res.json({
      success: true,
      type: 'box',
      brand_name: box.tenant_brand_name || brandName,
      product_name: box.product_name,
      product_spec: box.product_spec,
      batch_no: box.batch_no,
      status: box.status,
      status_text: box.status === 'invalid' ? '该码已作废' : !box.product_id ? '未绑定商品，尚未入库' : (isShipped ? '已发货' : '在库'),
      assigned_region: publicRegion(box.distributor_region),
      is_diversion: isDiversion,
      scan_count: historyCount + 1,
      first_scanned_at: firstScan?.scanned_at || '',
      first_scan_region: publicRegion(firstScan?.scan_location),
      scan_region: publicRegion(scanLocation),
      item_count: Number(itemSummary.item_count) || 0,
      verified_count: Number(itemSummary.verified_count) || 0,
      created_at: box.created_at,
      shipped_at: box.shipped_at || ''
      ,...publicContentFields(publicContent)
      ,product_content: publicContent
    });
  }

  // 再查子码
  let item = db.prepare(`
    SELECT i.*, b.box_code, b.status as parent_status, b.product_id as parent_product_id,
      COALESCE(b.brand_id,bp.brand_id) as parent_brand_id, b.batch_no as parent_batch_no,
      p.name as product_name, p.spec as product_spec, p.brand_id as product_brand_id,
      COALESCE(i.brand_id, p.brand_id) as eff_brand_id, br.name as tenant_brand_name,
      d.name as distributor_name, d.region as distributor_region, d.covered_regions as distributor_covered_regions,
      d.brand_id as distributor_brand_id,
      -- 同 box 分支：以「代理商品牌集合」为准，而不是兼容单字段
      CASE WHEN d.id IS NULL THEN 0
        WHEN EXISTS (SELECT 1 FROM distributor_brands dbr WHERE dbr.distributor_id=d.id AND dbr.brand_id=COALESCE(i.brand_id,p.brand_id)) THEN 0
        WHEN d.brand_id IS NOT COALESCE(i.brand_id,p.brand_id) THEN 1
        ELSE 0 END AS distributor_brand_mismatch
    FROM items i
    LEFT JOIN boxes b ON i.box_id = b.id
    LEFT JOIN products bp ON b.product_id = bp.id
    LEFT JOIN products p ON i.product_id = p.id
    LEFT JOIN brands br ON br.id = COALESCE(i.brand_id, p.brand_id)
    LEFT JOIN distributors d ON i.distributor_id = d.id
    WHERE i.item_code = ?
  `).get(code);

  if (item) {
    const itemBrandConflict = (item.product_id && (!item.product_brand_id || (item.brand_id && Number(item.brand_id) !== Number(item.product_brand_id)))) ||
      (item.distributor_id && Number(item.distributor_brand_mismatch) === 1);
    const boxConflict = item.box_id && (Number(item.parent_product_id) !== Number(item.product_id) ||
      Number(item.parent_brand_id) !== Number(item.eff_brand_id) || String(item.parent_batch_no || '') !== String(item.batch_no || ''));
    if (itemBrandConflict || boxConflict) {
      return res.status(409).json({ success: false, code: 'CODE_DATA_CONFLICT', msg: '该码的品牌、产品或批次资料存在历史冲突，已暂停公开展示，请联系品牌方核对原始生产资料' });
    }
    const publicContent = item.product_id && item.eff_brand_id ? productContent(item.product_id, item.eff_brand_id, item.batch_no, false) : { media: [], batch: null, trace: [], marketing: null };
    // 查验只更新查验信息，不能改变入库、发货或作废状态。
    db.prepare(`UPDATE items SET scanned_at=datetime('now','localtime'), scan_location=?, scan_ip=? WHERE id=?`)
      .run(scanLocation, sourceId, item.id);

    // 是否发货：只要绑定过代理商即视为已发货（避免被扫后状态变scanned导致串货检测失效）
    const isShipped = item.distributor_id != null;

    // 串货分级检测
    let isDiversion = 0;
    if (isShipped) {
      isDiversion = detectDiversion(item.distributor_region, scanLocation, item.distributor_covered_regions);
    }

    db.prepare(`INSERT INTO scan_logs (item_code, box_code, product_name, distributor_name, assigned_region, scan_location, scan_ip, is_diversion, latitude, longitude, brand_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(code, item.box_code, item.product_name, item.distributor_name || '', item.distributor_region || '', scanLocation, sourceId, isDiversion, latitude, longitude, item.eff_brand_id || null);
    // 串货预警：自动进入预警中心
    if (isDiversion > 0) {
      db.prepare(`INSERT INTO alerts (item_code, box_code, product_name, distributor_name, assigned_region, scan_location, level, brand_id)
        VALUES (?,?,?,?,?,?,?,?)`).run(code, item.box_code || '', item.product_name || '', item.distributor_name || '', item.distributor_region || '', scanLocation, isDiversion, item.eff_brand_id || null);
    }

    // 未绑定箱码的情况
    const isBound = !!item.box_code;

    // 扫码抽奖（仅已发货正品首次扫码参与）
    let prize = null;
    if (isBound && isShipped && item.parent_status !== 'invalid' && item.status !== 'invalid' && historyCount === 0) {
      prize = drawPrize(code, scanLocation);
    }

    return res.json({
      success: true,
      type: 'item',
      brand_name: item.tenant_brand_name || brandName,
      product_name: item.product_name,
      product_spec: item.product_spec,
      batch_no: item.batch_no,
      status: item.status,
      status_text: item.status === 'invalid' ? '该码已作废' : item.parent_status === 'invalid' ? '所属箱码已作废，该码已停止流转' : !item.product_id ? '未绑定商品，尚未入库' : (isShipped ? '正品已验证' : '产品未发货，请联系厂家'),
      assigned_region: publicRegion(item.distributor_region),
      is_diversion: isDiversion,
      scan_count: historyCount + 1,
      first_scanned_at: firstScan?.scanned_at || '',
      first_scan_region: publicRegion(firstScan?.scan_location),
      scan_region: publicRegion(scanLocation),
      prize: prize,
      created_at: item.created_at,
      scanned_at: new Date().toLocaleString('zh-CN')
      ,...publicContentFields(publicContent)
      ,product_content: publicContent
    });
  }

  res.json({ success: false, msg: '溯源码不存在，请核实！' });
}));

// 动态生成二维码（用于入口二维码等）
app.get('/api/qr', requireLogin, wrap(async (req, res) => {
  const data = String(req.query.data || '');
  if (!data) return res.json({ success: false, msg: '缺少data参数' });
  if (data.length > 2048) return res.status(413).json({ success: false, code: 'QR_DATA_TOO_LARGE', msg: '二维码内容过长' });
  try {
    const buf = await QRCode.toBuffer(data, { width: 300, margin: 1 });
    res.type('png').send(buf);
  } catch (e) {
    res.status(500).json({ success: false, msg: '二维码生成失败' });
  }
}));

// --- 品牌设置 & 营销活动 API ---

// 读取品牌设置
app.get('/api/settings', requireRole('admin'), (req, res) => {
  const settings = readOnlyAccess.publicSettings(db.prepare('SELECT key, value FROM settings').all());
  res.json({ success: true, settings });
});

// 保存品牌设置
app.post('/api/settings', requireRole('admin'), (req, res) => {
  const { brand_name, brand_subtitle, logo_text, logo_image, welcome_msg, theme_color, contact_phone, product_images, promo_video, show_scan_count } = req.body;
  const isLocalUpload = value => !value || /^\/uploads\/[A-Za-z0-9._-]+$/.test(String(value));
  const imageList = String(product_images || '').split(/\r?\n/).map(value => value.trim()).filter(Boolean);
  if (!isLocalUpload(logo_image) || !isLocalUpload(promo_video) || imageList.length > 6 || imageList.some(value => !isLocalUpload(value))) {
    return res.status(400).json({ success: false, code: 'INVALID_MEDIA_URL', msg: '品牌素材必须来自本系统上传且图片不能超过6张' });
  }
  const allowed = { brand_name, brand_subtitle, logo_text, logo_image, welcome_msg, theme_color, contact_phone, product_images, promo_video, show_scan_count };
  const upsert = db.prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
  for (const [k, v] of Object.entries(allowed)) {
    if (v !== undefined) upsert.run(k, String(v));
  }
  res.json({ success: true, msg: '品牌设置已保存' });
});

// --- 品牌素材上传（产品图片 / 宣传视频） ---

const uploadDir = path.join(__dirname, 'public', 'uploads');
const uploadStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    fs.mkdirSync(uploadDir, { recursive: true });
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const extensions = {
      'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif',
      'image/webp': '.webp', 'video/mp4': '.mp4', 'video/webm': '.webm',
      'video/quicktime': '.mov'
    };
    const ext = extensions[file.mimetype];
    if (!ext) return cb(new Error('不支持的文件类型'));
    cb(null, `${Date.now()}-${crypto.randomBytes(12).toString('hex')}${ext}`);
  }
});
const imageUpload = multer({
  storage: uploadStorage,
  limits: { files: 6, fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /^image\/(jpeg|png|gif|webp)$/.test(file.mimetype))
});
const videoUpload = multer({
  storage: uploadStorage,
  limits: { fileSize: 100 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /^(video\/mp4|video\/webm|video\/quicktime)$/.test(file.mimetype))
});
const productImageUpload = multer({
  storage: uploadStorage,
  limits: { files: 6, fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /^image\/(jpeg|png|webp)$/.test(file.mimetype))
});

function uploadMagicMatches(file) {
  const fd = fs.openSync(file.path, 'r');
  const head = Buffer.alloc(16);
  let bytesRead = 0;
  try { bytesRead = fs.readSync(fd, head, 0, head.length, 0); } finally { fs.closeSync(fd); }
  const data = head.subarray(0, bytesRead);
  const ascii = data.toString('ascii');
  const signatures = {
    'image/jpeg': () => data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff,
    'image/png': () => data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a])),
    'image/gif': () => ascii.startsWith('GIF87a') || ascii.startsWith('GIF89a'),
    'image/webp': () => ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WEBP',
    'video/mp4': () => ascii.slice(4, 8) === 'ftyp',
    'video/quicktime': () => ascii.slice(4, 8) === 'ftyp',
    'video/webm': () => data.length >= 4 && data.subarray(0, 4).equals(Buffer.from([0x1a,0x45,0xdf,0xa3]))
  };
  return Boolean(signatures[file.mimetype]?.());
}
function removeUploadedFiles(files) {
  for (const file of files || []) {
    try { fs.unlinkSync(file.path); } catch {}
  }
}

const PRODUCT_IMAGE_MAX_PIXELS = 40 * 1000 * 1000;
const PRODUCT_IMAGE_MAX_DIMENSION = 2400;
async function normalizeProductImage(file) {
  const outputName = `${Date.now()}-${crypto.randomBytes(12).toString('hex')}.webp`;
  const outputPath = path.join(uploadDir, outputName);
  try {
    const pipeline = sharp(file.path, { failOn: 'error', limitInputPixels: PRODUCT_IMAGE_MAX_PIXELS, sequentialRead: true });
    const metadata = await pipeline.metadata();
    if (!['jpeg', 'png', 'webp'].includes(metadata.format) || !metadata.width || !metadata.height || metadata.width * metadata.height > PRODUCT_IMAGE_MAX_PIXELS) {
      const error = new Error('图片像素尺寸或解码格式不符合要求');
      error.code = 'INVALID_IMAGE_DIMENSIONS';
      throw error;
    }
    // rotate() 根据 EXIF 方向归正；不调用 withMetadata() 即移除 EXIF、GPS、ICC 等元数据。
    await pipeline.rotate().resize({
      width: PRODUCT_IMAGE_MAX_DIMENSION,
      height: PRODUCT_IMAGE_MAX_DIMENSION,
      fit: 'inside',
      withoutEnlargement: true
    }).webp({ quality: 82, effort: 4 }).toFile(outputPath);
    fs.chmodSync(outputPath, 0o640);
    return { path: outputPath, url: `/uploads/${outputName}` };
  } catch (error) {
    try { fs.unlinkSync(outputPath); } catch {}
    throw error;
  } finally {
    try { fs.unlinkSync(file.path); } catch {}
  }
}

// 上传产品图片（多张，返回URL列表）
app.post('/api/upload/images', requireRole('admin'), (req, res) => {
  imageUpload.array('files', 6)(req, res, (err) => {
    if (err) {
      removeUploadedFiles(req.files);
      return res.json({ success: false, msg: err.code === 'LIMIT_FILE_SIZE' ? '单张图片不能超过5MB' : '图片上传失败：' + err.message });
    }
    if (!req.files || req.files.length === 0) return res.json({ success: false, msg: '请选择图片文件（jpg/png/gif/webp）' });
    if (req.files.some(file => !uploadMagicMatches(file))) {
      removeUploadedFiles(req.files);
      return res.status(415).json({ success: false, code: 'INVALID_FILE_CONTENT', msg: '图片内容与文件类型不一致' });
    }
    res.json({ success: true, urls: req.files.map(f => `/uploads/${f.filename}`) });
  });
});

// 上传宣传视频（单个）
app.post('/api/upload/video', requireRole('admin'), (req, res) => {
  videoUpload.single('file')(req, res, (err) => {
    if (err) {
      removeUploadedFiles(req.file ? [req.file] : []);
      return res.json({ success: false, msg: err.code === 'LIMIT_FILE_SIZE' ? '视频不能超过100MB' : '视频上传失败：' + err.message });
    }
    if (!req.file) return res.json({ success: false, msg: '请选择视频文件' });
    if (!uploadMagicMatches(req.file)) {
      removeUploadedFiles([req.file]);
      return res.status(415).json({ success: false, code: 'INVALID_FILE_CONTENT', msg: '视频内容与文件类型不一致' });
    }
    res.json({ success: true, url: `/uploads/${req.file.filename}` });
  });
});

// --- Excel 导出 ---

// 公共：生成并发送 xlsx
async function sendWorkbook(res, wb, filename) {
  const buf = await wb.xlsx.writeBuffer();
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
  res.send(Buffer.from(buf));
}
const diversionText = (v) => v >= 2 ? '重度串货(跨省)' : v === 1 ? '轻度串货' : '正常';
const hasCodeBrandConflict = row => !!(row.product_id && (!row.product_brand_id || (row.brand_id && Number(row.brand_id) !== Number(row.product_brand_id))));

// 导出码表（箱码/子码，支持关键词；brand 只导自己品牌）
app.get('/api/export/codes', requireRole('admin', 'brand', 'brand_staff'), wrap(async (req, res) => {
  const type = req.query.type === 'box' ? 'box' : 'item';
  const keyword = (req.query.keyword || '').trim();
  const scopeSet = brandScopeSet(req);
  const scopeVals = scopeSet === null ? [] : brandSetValues(scopeSet);
  const scopePh = scopeVals.map(() => '?').join(',');
  const wb = new ExcelJS.Workbook();
  const today = new Date().toISOString().slice(0, 10);

  if (type === 'box') {
    const conds = [];
    const params = [];
    if (scopeSet !== null) { conds.push(`COALESCE(b.brand_id, p.brand_id) IN (${scopePh})`); params.push(...scopeVals); }
    if (keyword) { conds.push('(b.box_code LIKE ? OR p.name LIKE ?)'); params.push(`%${keyword}%`, `%${keyword}%`); }
    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
    const rows = db.prepare(`
      SELECT b.*, p.name as product_name, p.brand_id as product_brand_id, d.name as distributor_name, d.region as distributor_region,
        (SELECT COUNT(*) FROM items i WHERE i.box_id=b.id AND i.scanned_at IS NOT NULL) as scanned_count
      FROM boxes b
      LEFT JOIN products p ON b.product_id = p.id
      LEFT JOIN distributors d ON b.distributor_id = d.id
      ${where} ORDER BY b.id DESC
    `).all(...params);
    if (rows.some(hasCodeBrandConflict)) return res.status(409).json({ success: false, code: 'CODE_BRAND_CONFLICT', msg: '筛选结果包含品牌与产品冲突的历史码，已阻止导出，请先核对原始生产资料' });
    const ws = wb.addWorksheet('箱码表');
    ws.columns = [
      { header: '箱码', key: 'c1', width: 24 }, { header: '产品', key: 'c2', width: 20 },
      { header: '批次号', key: 'c3', width: 14 }, { header: '箱内数量', key: 'c4', width: 10 },
      { header: '已扫码数', key: 'c5', width: 10 }, { header: '状态', key: 'c6', width: 10 },
      { header: '代理商', key: 'c7', width: 16 }, { header: '代理区域', key: 'c8', width: 16 },
      { header: '发货时间', key: 'c9', width: 20 }, { header: '创建时间', key: 'c10', width: 20 }
    ];
    rows.forEach(r => ws.addRow([r.box_code, r.product_name || '', r.batch_no || '', r.item_count, r.scanned_count || 0,
      r.status === 'invalid' ? '已作废' : r.status === 'shipped' ? '已发货' : '在库', r.distributor_name || '', r.distributor_region || '', r.shipped_at || '', r.created_at]));
    await sendWorkbook(res, wb, `箱码表-${today}.xlsx`);
  } else {
    const conds = [];
    const params = [];
    if (scopeSet !== null) { conds.push(`COALESCE(i.brand_id, p.brand_id) IN (${scopePh})`); params.push(...scopeVals); }
    if (keyword) { conds.push('(i.item_code LIKE ? OR p.name LIKE ?)'); params.push(`%${keyword}%`, `%${keyword}%`); }
    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
    const rows = db.prepare(`
      SELECT i.*, p.name as product_name, p.brand_id as product_brand_id, b.box_code, d.name as distributor_name, d.region as distributor_region
      FROM items i
      LEFT JOIN products p ON i.product_id = p.id
      LEFT JOIN boxes b ON i.box_id = b.id
      LEFT JOIN distributors d ON i.distributor_id = d.id
      ${where} ORDER BY i.id DESC
    `).all(...params);
    if (rows.some(hasCodeBrandConflict)) return res.status(409).json({ success: false, code: 'CODE_BRAND_CONFLICT', msg: '筛选结果包含品牌与产品冲突的历史码，已阻止导出，请先核对原始生产资料' });
    const ws = wb.addWorksheet('子码表');
    ws.columns = [
      { header: '子码', key: 'c1', width: 24 }, { header: '所属箱码', key: 'c2', width: 24 },
      { header: '产品', key: 'c3', width: 20 }, { header: '批次号', key: 'c4', width: 14 },
      { header: '状态', key: 'c5', width: 10 }, { header: '代理商', key: 'c6', width: 16 },
      { header: '代理区域', key: 'c7', width: 16 }, { header: '发货时间', key: 'c8', width: 20 },
      { header: '扫码时间', key: 'c9', width: 20 }, { header: '创建时间', key: 'c10', width: 20 }
    ];
    rows.forEach(r => ws.addRow([r.item_code, r.box_code || '未绑定', r.product_name || '', r.batch_no || '',
      r.status === 'invalid' ? '已作废' : r.status === 'shipped' ? '已发货' : r.status === 'packing' ? '待确认入库' : r.status === 'scanned' ? '已入库' : '在库',
      r.distributor_name || '', r.distributor_region || '', r.shipped_at || '', r.scanned_at || '', r.created_at]));
    await sendWorkbook(res, wb, `子码表-${today}.xlsx`);
  }
}));

// ===================== 码包下载 / 批量打印 =====================

// 极简 ZIP 打包器（STORE 不压缩模式，零依赖；QR PNG 本身已压缩）
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function buildZip(entries) { // entries: [{name, data:Buffer}]
  const parts = []; const central = []; let offset = 0;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const crc = crc32(e.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);          // version needed
    local.writeUInt16LE(0x0800, 6);      // UTF-8 文件名标志
    local.writeUInt16LE(0, 8);           // STORE
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(e.data.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    parts.push(local, nameBuf, e.data);
    central.push({ nameBuf, crc, size: e.data.length, offset });
    offset += 30 + nameBuf.length + e.data.length;
  }
  const centralParts = []; let centralSize = 0;
  for (const c of central) {
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt32LE(c.crc, 16);
    ch.writeUInt32LE(c.size, 20); ch.writeUInt32LE(c.size, 24);
    ch.writeUInt16LE(c.nameBuf.length, 28);
    ch.writeUInt32LE(c.offset, 42);
    centralParts.push(ch, c.nameBuf);
    centralSize += 46 + c.nameBuf.length;
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(central.length, 8); end.writeUInt16LE(central.length, 10);
  end.writeUInt32LE(centralSize, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, ...centralParts, end]);
}

// 图片归档会同时持有二维码和最终 ZIP 缓冲区。限制数量与并发，避免大码包
// 阻塞单进程或触发 OOM；大批量生产始终使用下面的流式 TXT 导出。
function reserveImageArchive(res) {
  if (imageArchiveJobs >= IMAGE_ARCHIVE_MAX_CONCURRENT) return null;
  imageArchiveJobs += 1;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    imageArchiveJobs = Math.max(0, imageArchiveJobs - 1);
  };
  res.once('finish', release);
  res.once('close', release);
  return release;
}

function rejectOversizeImageArchive(res, count) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Image-Archive-Limit', String(IMAGE_ARCHIVE_MAX_CODES));
  return res.status(413).json({
    success: false,
    code: 'IMAGE_ARCHIVE_TOO_LARGE',
    msg: `图片包单次最多 ${IMAGE_ARCHIVE_MAX_CODES.toLocaleString('zh-CN')} 个码；当前 ${Number(count).toLocaleString('zh-CN')} 个。请使用链接 TXT/纯码 TXT，或缩小筛选范围后分批导出。`
  });
}

// 构造箱/子码查询条件（码列表/码包/打印共用）
function buildCodeConds(type, scopeSet, { keyword, status, ids } = {}) {
  const conds = []; const params = [];
  const scopeVals = scopeSet === null ? [] : brandSetValues(scopeSet);
  const scopePh = scopeVals.map(() => '?').join(',');
  if (type === 'box') {
    if (scopeSet !== null) { conds.push(`COALESCE(b.brand_id, p.brand_id) IN (${scopePh})`); params.push(...scopeVals); }
    if (keyword) { conds.push('(b.box_code LIKE ? OR p.name LIKE ?)'); params.push(`%${keyword}%`, `%${keyword}%`); }
    if (status === 'shipped') conds.push("b.status='shipped'");
    else if (status === 'in_stock') conds.push("b.status='in_stock'");
    else if (status === 'packing') conds.push("b.status='packing'");
    else if (status === 'invalid') conds.push("b.status='invalid'");
    if (ids && ids.length) { conds.push('b.id IN (' + ids.map(() => '?').join(',') + ')'); params.push(...ids); }
  } else {
    if (scopeSet !== null) { conds.push(`COALESCE(i.brand_id, p.brand_id) IN (${scopePh})`); params.push(...scopeVals); }
    if (keyword) { conds.push('(i.item_code LIKE ? OR p.name LIKE ?)'); params.push(`%${keyword}%`, `%${keyword}%`); }
    if (status === 'scanned') conds.push("i.status='scanned'");
    else if (status === 'shipped') conds.push("i.status='shipped'");
    else if (status === 'in_stock') conds.push("i.status='in_stock'");
    else if (status === 'packing') conds.push("i.status='packing'");
    else if (status === 'invalid') conds.push("i.status='invalid'");
    if (ids && ids.length) { conds.push('i.id IN (' + ids.map(() => '?').join(',') + ')'); params.push(...ids); }
  }
  return { where: conds.length ? 'WHERE ' + conds.join(' AND ') : '', params };
}

// 读取码的 QR 图（不存在则现场生成，保证老码也能出包）
async function getQrBuffer(code, width, baseUrl) {
  const qrPath = path.join(__dirname, 'public', 'qr', `${code}.png`);
  try { return fs.readFileSync(qrPath); } catch (e) {}
  const buf = await QRCode.toBuffer(`${baseUrl}/v/${code}`, { width, margin: 1 });
  try { fs.writeFileSync(qrPath, buf); } catch (e) {}
  return buf;
}
// XML 转义
function xmlEsc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

// 生成「二维码 + 品牌名 + 码值」标签 SVG（矢量图，印刷制版推荐用）
async function buildLabelSvg(code, brandName, isBox, baseUrl) {
  const url = `${baseUrl}/v/${code}`;
  let qrSvg = await QRCode.toString(url, { type: 'svg', margin: 0 });
  qrSvg = qrSvg.replace(/<\?xml[^>]*\?>\s*/i, '').trim();
  // 给内层 svg 加定位与尺寸（箱码大标签 260x340，子码 210x280）
  const W = isBox ? 260 : 210, QR = isBox ? 212 : 168, X = Math.round((W - QR) / 2), Y = 16;
  qrSvg = qrSvg.replace(/<svg /i, `<svg x="${X}" y="${Y}" width="${QR}" height="${QR}" `);
  const brand = brandName || '';
  const brandFs = isBox ? 30 : 24;
  const brandY = isBox ? 268 : 218;
  const codeY = isBox ? 308 : 252;
  const codeFs = isBox ? 17 : 14;
  const H = isBox ? 330 : 270;
  const brandText = brand
    ? `<text x="${W / 2}" y="${brandY}" text-anchor="middle" font-family="Microsoft YaHei, SimHei, sans-serif" font-size="${brandFs}" font-weight="bold" fill="#111">${xmlEsc(brand)}</text>`
    : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<rect width="${W}" height="${H}" fill="#ffffff"/>
${qrSvg}
${brandText}
<text x="${W / 2}" y="${codeY}" text-anchor="middle" font-family="Consolas, monospace" font-size="${codeFs}" fill="#333">${xmlEsc(code)}</text>
</svg>`;
}

function scopedCodePackage(req, packageId) {
  const scopeSet = brandScopeSet(req);
  return scopeSet === null
    ? db.prepare('SELECT * FROM code_packages WHERE id=?').get(packageId)
    : db.prepare(`SELECT * FROM code_packages WHERE id=? AND brand_id IN (${brandSetValues(scopeSet).map(() => '?').join(',')})`).get(packageId, ...brandSetValues(scopeSet));
}

// 工厂码包下载：mode=url → 链接 TXT；mode=code → 纯码 TXT；mode=zip → 每码一张二维码 PNG + 码数据 TXT 打包 ZIP。
// 文件内容由 package_id 精确绑定，不受后续筛选条件或新增码影响。
app.get('/api/code-packages/:id/download', requireRole('admin', 'brand', 'brand_staff'), wrap(async (req, res) => {
  const packageId = Number(req.params.id);
  if (!Number.isInteger(packageId) || packageId < 1) {
    return res.status(400).json({ success: false, code: 'PACKAGE_ID_INVALID', msg: '码包编号无效' });
  }
  const pkg = scopedCodePackage(req, packageId);
  if (!pkg) return res.status(404).json({ success: false, code: 'PACKAGE_NOT_FOUND', msg: '码包不存在或无权访问' });
  if (pkg.product_id && !db.prepare('SELECT 1 FROM products WHERE id=? AND brand_id=?').get(pkg.product_id,pkg.brand_id)) {
    return res.status(409).json({success:false,code:'PACKAGE_BRAND_CONFLICT',msg:'历史码包的产品与品牌不一致，已阻止导出，请核对原始生产资料'});
  }
  if (pkg.status !== 'ready') {
    return res.status(409).json({ success: false, code: 'PACKAGE_NOT_READY', msg: '码包尚未生成完成' });
  }
  const mode = req.query.mode === 'code' ? 'code' : (req.query.mode === 'zip' ? 'zip' : 'url');
  const table = pkg.code_type === 'box' ? 'boxes' : 'items';
  const column = pkg.code_type === 'box' ? 'box_code' : 'item_code';
  const actual = db.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE package_id=?`).get(packageId).c;
  if (actual !== pkg.quantity) {
    console.error(JSON.stringify({ level: 'error', event: 'code_package_count_mismatch', requestId: req.requestId, packageId, expected: pkg.quantity, actual }));
    return res.status(409).json({ success: false, code: 'PACKAGE_COUNT_MISMATCH', msg: '码包完整性校验失败，请联系平台管理员' });
  }
  if (mode === 'zip' && actual > IMAGE_ARCHIVE_MAX_CODES) {
    return rejectOversizeImageArchive(res, actual);
  }

  const rows = db.prepare(`SELECT ${column} AS code FROM ${table} WHERE package_id=? ORDER BY id ASC`).all(packageId);

  const audit = (suffix) => {
    try {
      db.prepare(`UPDATE code_packages SET download_count=download_count+1,last_downloaded_at=datetime('now','localtime') WHERE id=?`).run(packageId);
      logOperation(req, 'download_code_package', 'code_package', packageId,
        `下载码包 ${pkg.package_no}（${suffix}，${pkg.quantity} 个）`);
    } catch (error) {
      console.error(JSON.stringify({ level: 'error', event: 'code_package_download_audit_failed', requestId: req.requestId, packageId, message: error.message }));
    }
  };

  // ZIP 模式：每码一张二维码 PNG + 码数据 TXT（链接清单 + 纯码清单）
  if (mode === 'zip') {
    const releaseArchive = reserveImageArchive(res);
    if (!releaseArchive) {
      res.setHeader('Retry-After', '30');
      return res.status(429).json({ success: false, code: 'IMAGE_ARCHIVE_BUSY', msg: '已有图片包正在生成，请稍后重试；TXT 码包可立即下载。' });
    }
    const baseUrl = getBaseUrl(req);
    const typeLabel = pkg.code_type === 'box' ? '箱码' : '子码';
    const width = pkg.code_type === 'box' ? 300 : 200;
    try {
      const entries = [];
      const urlLines = [];
      const codeLines = [];
      for (const row of rows) {
        const code = row.code;
        const png = await getQrBuffer(code, width, baseUrl);
        entries.push({ name: `${typeLabel}/${code}.png`, data: png });
        urlLines.push(`${baseUrl}/v/${code}`);
        codeLines.push(code);
      }
      entries.push({ name: '扫码链接清单.txt', data: Buffer.from(urlLines.join('\r\n') + '\r\n', 'utf8') });
      entries.push({ name: '纯码清单.txt', data: Buffer.from(codeLines.join('\r\n') + '\r\n', 'utf8') });
      entries.push({ name: '使用说明.txt', data: Buffer.from(
        `${typeLabel}码包（二维码图片 + 码数据）\r\n` +
        `码包编号：${pkg.package_no}\r\n` +
        `共 ${rows.length} 个码。\r\n\r\n` +
        `【${typeLabel}/】纯二维码 PNG 图（${width}x${width}px），以码值命名。\r\n` +
        `【扫码链接清单.txt】每行一个完整扫码链接。\r\n` +
        `【纯码清单.txt】每行一个纯码值。\r\n` +
        `生成时间：${new Date().toLocaleString('zh-CN')}\r\n`, 'utf8') });
      const zip = buildZip(entries);
      const fname = `${typeLabel}码包-${pkg.package_no}-${pkg.quantity}-图片包.zip`;
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(fname)}`);
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Code-Package-No', pkg.package_no);
      res.setHeader('X-Code-Package-Count', String(pkg.quantity));
      res.setHeader('X-Image-Archive-Limit', String(IMAGE_ARCHIVE_MAX_CODES));
      audit('图片包 ZIP');
      return res.send(zip);
    } catch (error) {
      releaseArchive();
      throw error;
    }
  }

  const suffix = mode === 'code' ? '纯码值' : '扫码链接';
  const filename = `${pkg.code_type === 'box' ? '箱码' : '子码'}码包-${pkg.package_no}-${pkg.quantity}-${suffix}.txt`;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Code-Package-No', pkg.package_no);
  res.setHeader('X-Code-Package-Count', String(pkg.quantity));

  res.on('finish', () => audit(suffix + ' TXT'));
  for (const row of rows) {
    const value = mode === 'code' ? row.code : `${pkg.base_url}/v/${row.code}`;
    res.write(value + '\r\n');
  }
  res.end();
}));

// 码包下载：按筛选条件打包（QR PNG 每码一张 + 清单.csv），发印刷厂直接可用
app.get('/api/codes/package', requireRole('admin', 'brand', 'brand_staff'), wrap(async (req, res) => {
  const type = req.query.type === 'box' ? 'box' : 'item';
  const keyword = (req.query.keyword || '').trim();
  const status = (req.query.status || '').trim();
  const ids = (req.query.ids || '').split(',').map(s => parseInt(s)).filter(n => Number.isInteger(n) && n > 0);
  const scopeSet = brandScopeSet(req);
  const baseUrl = getBaseUrl(req);
  const { where, params } = buildCodeConds(type, scopeSet, { keyword, status, ids });

  const rows = type === 'box'
    ? db.prepare(`SELECT b.*, p.name as product_name, p.brand_id as product_brand_id, br.name as brand_name FROM boxes b LEFT JOIN products p ON b.product_id=p.id LEFT JOIN brands br ON br.id=COALESCE(b.brand_id,p.brand_id) ${where} ORDER BY b.id ASC LIMIT ${IMAGE_ARCHIVE_MAX_CODES + 1}`).all(...params)
    : db.prepare(`SELECT i.*, p.name as product_name, p.brand_id as product_brand_id, br.name as brand_name FROM items i LEFT JOIN products p ON i.product_id=p.id LEFT JOIN brands br ON br.id=COALESCE(i.brand_id,p.brand_id) ${where} ORDER BY i.id ASC LIMIT ${IMAGE_ARCHIVE_MAX_CODES + 1}`).all(...params);

  if (!rows.length) return res.json({ success: false, msg: '没有符合条件的码' });
  if (rows.length > IMAGE_ARCHIVE_MAX_CODES) return rejectOversizeImageArchive(res, rows.length);
  if (rows.some(hasCodeBrandConflict)) return res.status(409).json({ success: false, code: 'CODE_BRAND_CONFLICT', msg: '筛选结果包含品牌与产品冲突的历史码，已阻止打包，请先核对原始生产资料' });

  const releaseArchive = reserveImageArchive(res);
  if (!releaseArchive) {
    res.setHeader('Retry-After', '30');
    return res.status(429).json({ success: false, code: 'IMAGE_ARCHIVE_BUSY', msg: '已有图片包正在生成，请稍后重试。' });
  }
  try {
  const entries = [];
  const csvLines = [type === 'box' ? '\uFEFF箱码,品牌,产品,批次号,数量,状态,创建时间' : '\uFEFF子码,品牌,产品,批次号,所属箱码,状态,创建时间'];
  for (const r of rows) {
    const code = r.box_code || r.item_code;
    const png = await getQrBuffer(code, type === 'box' ? 300 : 200, baseUrl);
    entries.push({ name: `${type === 'box' ? '箱码' : '子码'}/${code}.png`, data: png });
    // 带品牌名+码值的矢量标签（印刷制版推荐）
    const svg = await buildLabelSvg(code, r.brand_name || '', type === 'box', baseUrl);
    entries.push({ name: `带品牌标签/${code}.svg`, data: Buffer.from(svg, 'utf8') });
    const st = r.status === 'invalid' ? '已作废' : r.status === 'shipped' ? '已发货' : r.status === 'packing' ? '待确认入库' : r.status === 'scanned' ? '已入库' : '在库';
    if (type === 'box') {
      csvLines.push([code, r.brand_name || '', r.product_name || '未绑定', r.batch_no || '', r.item_count || 0, st, r.created_at].map(v => `"${String(v).replace(/"/g, '""')}"`).join(','));
    } else {
      let boxCode = '';
      if (r.box_id) boxCode = (db.prepare('SELECT box_code FROM boxes WHERE id=?').get(r.box_id) || {}).box_code || '';
      csvLines.push([code, r.brand_name || '', r.product_name || '未绑定', r.batch_no || '', boxCode, st, r.created_at].map(v => `"${String(v).replace(/"/g, '""')}"`).join(','));
    }
  }
  // 纯文本链接清单：每行一个扫码链接，对齐旧码包格式，工厂直接印刷用
  const urlLines = rows.map(r => {
    const code = r.box_code || r.item_code;
    return baseUrl + '/v/' + code;
  });
  entries.push({ name: '链接清单.txt', data: Buffer.from(urlLines.join('\r\n') + '\r\n', 'utf8') });

  entries.push({ name: '清单.csv', data: Buffer.from(csvLines.join('\r\n'), 'utf8') });
  entries.push({ name: '使用说明.txt', data: Buffer.from(
    `${type === 'box' ? '箱码' : '子码'}码包\r\n` +
    `共 ${rows.length} 个二维码。\r\n\r\n` +
    `【带品牌标签/】推荐使用：矢量 SVG 标签图（二维码+品牌名+码值），制版清晰无锯齿，可直接用于包装印刷。文件以码值命名（如 ABC123.svg）。\r\n` +
    `【${type === 'box' ? '箱码' : '子码'}/】纯二维码 PNG 图（${type === 'box' ? 300 : 200}x${type === 'box' ? 300 : 200}px），以码值命名，仅含二维码。\r\n` +
    `【链接清单.txt】纯文本、每行一个扫码链接（可直接复制给印刷厂制版二维码）。\r\n` +
    `【清单.csv】可用 Excel 打开核对（含品牌、产品、批次、状态）。\r\n` +
    `生成时间：${new Date().toLocaleString('zh-CN')}\r\n`, 'utf8') });

  const zip = buildZip(entries);
  const today = new Date().toISOString().slice(0, 10);
  const fname = `${type === 'box' ? '箱码' : '子码'}码包-${today}.zip`;
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(fname)}`);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Image-Archive-Limit', String(IMAGE_ARCHIVE_MAX_CODES));
  return res.send(zip);
  } catch (error) {
    releaseArchive();
    throw error;
  }
}));

// 导出扫码日志（brand 只导自己品牌）
app.get('/api/export/logs', requireRole('admin', 'brand', 'brand_staff'), wrap(async (req, res) => {
  const scopeSet = brandScopeSet(req);
  const rows = scopeSet === null
    ? db.prepare('SELECT * FROM scan_logs ORDER BY scanned_at DESC LIMIT 50000').all()
    : db.prepare(`SELECT * FROM scan_logs WHERE brand_id IN (${brandSetValues(scopeSet).map(() => '?').join(',')}) ORDER BY scanned_at DESC LIMIT 50000`).all(...brandSetValues(scopeSet));
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('扫码日志');
  ws.columns = [
    { header: '扫码时间', key: 'c1', width: 20 }, { header: '溯源码', key: 'c2', width: 24 },
    { header: '箱码', key: 'c3', width: 24 }, { header: '产品', key: 'c4', width: 20 },
    { header: '代理商', key: 'c5', width: 16 }, { header: '指定区域', key: 'c6', width: 16 },
    { header: '扫码位置', key: 'c7', width: 20 }, { header: '纬度', key: 'c8', width: 10 },
    { header: '经度', key: 'c9', width: 10 }, { header: '来源标识', key: 'c10', width: 22 },
    { header: '串货状态', key: 'c11', width: 16 }
  ];
  rows.forEach(r => ws.addRow([r.scanned_at, r.item_code, r.box_code || '', r.product_name || '', r.distributor_name || '',
    r.assigned_region || '', r.scan_location || '', r.latitude ?? '', r.longitude ?? '', displayScanSource(r.scan_ip), diversionText(r.is_diversion)]));
  const today = new Date().toISOString().slice(0, 10);
  await sendWorkbook(res, wb, `扫码日志-${today}.xlsx`);
}));

// 导出发货记录（brand 只导自己品牌）
app.get('/api/export/shipments', requireRole('admin', 'warehouse', 'brand', 'brand_staff'), wrap(async (req, res) => {
  const scopeSet = brandScopeSet(req);
  const date = (req.query.date || '').trim();
  const order_no = (req.query.order_no || '').trim();          // 订单编号（模糊）
  const distributor_id = (req.query.distributor_id || '').trim(); // 代理商 id
  const code = (req.query.code || '').trim();                  // 兼容旧参数：箱码或子码（模糊）
  const box_code = (req.query.box_code || '').trim();          // 箱码（模糊）
  const item_code = (req.query.item_code || '').trim();        // 子码/字码（模糊）
  const remark = (req.query.remark || '').trim();              // 备注（模糊）
  const q = (req.query.q || '').trim();                        // 兼容旧参数：订单号或备注

  // 与列表 /api/shipments 同源同口径：品牌过滤 + 多条件过滤
  // 品牌过滤：优先按**货物**品牌；货物品牌缺失时才回落到代理商，且回落时按
  // 「代理商的任一品牌」判定（兼容单字段会让多品牌代理商的记录在别的品牌范围里看不见）。
  let brandFilter = scopeSet === null ? '' : ` WHERE (
      COALESCE(p_box.brand_id, p_item.brand_id) IN (${brandSetValues(scopeSet).map(() => '?').join(',')})
      OR (COALESCE(p_box.brand_id, p_item.brand_id) IS NULL
          AND (SELECT COUNT(*) FROM (
                 SELECT d.brand_id AS bid
                 UNION SELECT dz.brand_id FROM distributor_brands dz WHERE dz.distributor_id=d.id
               ) q WHERE q.bid IN (${brandSetValues(scopeSet).map(() => '?').join(',')})) > 0)
    )`;
  const params = scopeSet === null ? [] : [...brandSetValues(scopeSet), ...brandSetValues(scopeSet)];
  const pushFilter = (cond, ...values) => {
    brandFilter += (brandFilter ? ' AND' : ' WHERE') + cond;
    params.push(...values);
  };
  if (date) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ success: false, msg: '日期格式错误，应为 YYYY-MM-DD' });
    }
    pushFilter(' date(s.shipped_at)=?', date);
  }
  if (order_no) pushFilter(" s.order_no LIKE ? ESCAPE '\\'", `%${likeLiteral(order_no)}%`);
  if (distributor_id) pushFilter(' s.distributor_id=?', parseInt(distributor_id) || 0);
  if (code) pushFilter(" (b.box_code LIKE ? ESCAPE '\\' OR s.item_code LIKE ? ESCAPE '\\')", `%${likeLiteral(code)}%`, `%${likeLiteral(code)}%`);
  if (box_code) pushFilter(" b.box_code LIKE ? ESCAPE '\\'", `%${likeLiteral(box_code)}%`);
  if (item_code) pushFilter(" s.item_code LIKE ? ESCAPE '\\'", `%${likeLiteral(item_code)}%`);
  if (remark) pushFilter(" s.remark LIKE ? ESCAPE '\\'", `%${likeLiteral(remark)}%`);
  if (q) pushFilter(" (s.order_no LIKE ? ESCAPE '\\' OR s.remark LIKE ? ESCAPE '\\')", `%${likeLiteral(q)}%`, `%${likeLiteral(q)}%`);

  const rows = db.prepare(`
    SELECT s.*,
      b.box_code, b.item_count,
      COALESCE(p_box.name, p_item.name) as product_name,
      COALESCE(p_box.spec, p_item.spec) as product_spec,
      d.name as distributor_name, d.region as distributor_region,
      COALESCE(b.batch_no, i.batch_no) as batch_no,
      CASE WHEN s.item_code IS NOT NULL AND s.item_code != '' THEN 1 ELSE COALESCE(b.item_count, 0) END as product_qty,
      CASE WHEN s.item_code IS NOT NULL AND s.item_code != '' THEN 0 ELSE 1 END as box_qty
    FROM shipments s
    LEFT JOIN boxes b ON s.box_id = b.id
    LEFT JOIN items i ON s.item_code = i.item_code
    LEFT JOIN products p_box ON b.product_id = p_box.id
    LEFT JOIN products p_item ON i.product_id = p_item.id
    LEFT JOIN distributors d ON s.distributor_id = d.id
    ${brandFilter}
    ORDER BY s.shipped_at DESC
    LIMIT 50000
  `).all(...params);

  // 与列表一致的聚合：订单 + 产品 + 代理商 + 发货时间，并补充箱→子码追溯
  const boxIds = rows.map(s => s.box_id).filter(id => id != null);
  let itemsByBox = {};
  if (boxIds.length) {
    const ph = boxIds.map(() => '?').join(',');
    const itemRows = db.prepare(`SELECT box_id, item_code FROM items WHERE box_id IN (${ph}) ORDER BY id ASC`).all(...boxIds);
    itemRows.forEach(it => { (itemsByBox[it.box_id] = itemsByBox[it.box_id] || []).push(it.item_code); });
  }

  const groupsMap = new Map();
  for (const r of rows) {
    const key = [r.order_no || '', r.product_name || '', r.distributor_name || '', r.shipped_at || ''].join('\u0001');
    if (!groupsMap.has(key)) {
      groupsMap.set(key, {
        shipped_at: r.shipped_at, operator: r.operator || '', order_no: r.order_no || '',
        remark: r.remark || '', product_name: r.product_name || '', product_spec: r.product_spec || '',
        distributor_name: r.distributor_name || '', distributor_region: r.distributor_region || '',
        product_qty: 0, box_qty: 0, boxes: [], loose_items: []
      });
    }
    const g = groupsMap.get(key);
    g.product_qty += r.product_qty || 0;
    g.box_qty += r.box_qty || 0;
    if (r.item_code) {
      g.loose_items.push(r.item_code);
    } else if (r.box_code) {
      g.boxes.push({ box_code: r.box_code, item_codes: itemsByBox[r.box_id] || [] });
    }
  }
  let groups = Array.from(groupsMap.values());

  // 与前端列表同口径的搜索过滤（订单号/产品名/代理商/备注）
  if (q) {
    const ql = q.toLowerCase();
    groups = groups.filter(g =>
      (g.product_name || '').toLowerCase().includes(ql) ||
      (g.order_no || '').toLowerCase().includes(ql) ||
      (g.distributor_name || '').toLowerCase().includes(ql) ||
      (g.remark || '').toLowerCase().includes(ql)
    );
  }

  // 码值明细：结构化「箱码[子码1、子码2…]；散件…」
  function codeDetail(g) {
    const parts = [];
    g.boxes.forEach(b => parts.push(b.box_code + (b.item_codes && b.item_codes.length ? '【' + b.item_codes.join('、') + '】' : '')));
    g.loose_items.forEach(c => parts.push(c + '（散）'));
    return parts.join('；');
  }

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('发货记录');
  ws.columns = [
    { header: '产品名称', key: 'c1', width: 22 }, { header: '产品件数', key: 'c2', width: 10 },
    { header: '箱数', key: 'c3', width: 8 }, { header: '订单编号', key: 'c4', width: 18 },
    { header: '代理商', key: 'c5', width: 16 }, { header: '区域', key: 'c6', width: 14 },
    { header: '操作人', key: 'c7', width: 12 }, { header: '发货时间', key: 'c8', width: 20 },
    { header: '备注', key: 'c9', width: 20 }, { header: '码值明细', key: 'c10', width: 50 }
  ];
  groups.forEach(g => ws.addRow([
    g.product_name + (g.product_spec ? '（' + g.product_spec + '）' : ''),
    g.product_qty, g.box_qty, g.order_no, g.distributor_name, g.distributor_region,
    g.operator, g.shipped_at, g.remark, codeDetail(g)
  ]));
  const today = new Date().toISOString().slice(0, 10);
  await sendWorkbook(res, wb, `发货记录-${date || today}.xlsx`);
}));

// 获取营销活动列表
app.get('/api/campaigns', requireRole('admin'), (req, res) => {
  const campaigns = db.prepare('SELECT * FROM campaigns ORDER BY id DESC').all();
  res.json({ success: true, campaigns });
});

// 创建/更新营销活动
app.post('/api/campaigns', requireRole('admin'), (req, res) => {
  const { id, name, start_date, end_date, win_rate, prize_type, prize_name, prize_min, prize_max, enabled } = req.body;
  if (!name) return res.json({ success: false, msg: '请输入活动名称' });
  const rate = Math.min(Math.max(parseInt(win_rate) || 0, 0), 100);
  const min = parseFloat(prize_min) || 0;
  const max = parseFloat(prize_max) || 0;

  if (id) {
    db.prepare(`UPDATE campaigns SET name=?, start_date=?, end_date=?, win_rate=?, prize_type=?, prize_name=?, prize_min=?, prize_max=?, enabled=? WHERE id=?`)
      .run(name, start_date || '', end_date || '', rate, prize_type || 'thanks', prize_name || '', min, max, enabled ? 1 : 0, id);
    res.json({ success: true, msg: '活动已更新' });
  } else {
    const r = db.prepare(`INSERT INTO campaigns (name, start_date, end_date, win_rate, prize_type, prize_name, prize_min, prize_max, enabled)
      VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(name, start_date || '', end_date || '', rate, prize_type || 'thanks', prize_name || '', min, max, enabled ? 1 : 0);
    res.json({ success: true, msg: '活动已创建', id: r.lastInsertRowid });
  }
});

// 启用/停用活动
app.post('/api/campaigns/:id/toggle', requireRole('admin'), (req, res) => {
  const c = db.prepare('SELECT * FROM campaigns WHERE id=?').get(req.params.id);
  if (!c) return res.json({ success: false, msg: '活动不存在' });
  db.prepare('UPDATE campaigns SET enabled=? WHERE id=?').run(c.enabled ? 0 : 1, c.id);
  res.json({ success: true, enabled: !c.enabled });
});

// 删除活动
app.delete('/api/campaigns/:id', requireRole('admin'), (req, res) => {
  db.prepare('DELETE FROM campaigns WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

// 获取中奖记录
app.get('/api/prizes', requireRole('admin'), (req, res) => {
  const prizes = db.prepare(`
    SELECT p.*, c.name as campaign_name
    FROM prize_records p LEFT JOIN campaigns c ON p.campaign_id = c.id
    ORDER BY p.id DESC LIMIT 100
  `).all();
  res.json({ success: true, prizes });
});

// 省级关键词（供串货判定与多区域匹配复用）
const PROVINCE_KEYS = ['北京', '上海', '天津', '重庆', '黑龙江', '内蒙古', '新疆', '西藏', '广西', '宁夏',
  '河北', '山西', '辽宁', '吉林', '江苏', '浙江', '安徽', '福建', '江西', '山东',
  '河南', '湖北', '湖南', '广东', '海南', '四川', '贵州', '云南', '陕西', '甘肃', '青海', '台湾', '香港', '澳门'];

function getProvinceName(str) {
  const s = String(str || '').trim();
  for (const p of PROVINCE_KEYS) if (s.includes(p)) return p;
  const m = s.match(/([\u4e00-\u9fa5]{2})省/);
  return m ? m[1] : '';
}

// 串货分级检测：返回 0=正常 1=轻度(同省跨市) 2=重度(跨省)
// coveredRegionsJson 为代理商多区域覆盖（可选，JSON 数组 [{p:省, c:市}]），有值则按多区域判定
function detectDiversion(assignedRegion, scanLocation, coveredRegionsJson) {
  if (!scanLocation) return 0;
  const s = String(scanLocation).trim();

  // 多区域覆盖判定
  let regions = [];
  try { regions = JSON.parse(coveredRegionsJson || '[]'); } catch (e) { regions = []; }
  if (Array.isArray(regions) && regions.length) {
    const ps = getProvinceName(s);
    for (const r of regions) {
      const rp = getProvinceName(r && r.p || '');
      if (!rp || rp !== ps) continue;          // 省不同 → 继续下一个区域
      if (!r.c) return 0;                       // 覆盖全省 → 正常
      const rc = String(r.c || '').replace(/市|地区|自治州|盟/g, '');
      if (rc && s.includes(rc)) return 0;       // 覆盖某市且城市匹配 → 正常
    }
    // 所有覆盖区域都不匹配 → 串货：同省跨市=轻度，跨省=重度
    const sameProvince = regions.some(r => r && r.p && getProvinceName(r.p) === ps);
    return sameProvince ? 1 : 2;
  }

  // 回退：单区域（旧逻辑）
  if (!assignedRegion) return 0;
  const a = String(assignedRegion).trim();
  if (a.includes(s) || s.includes(a)) return 0;
  const pa = getProvinceName(a), ps2 = getProvinceName(s);
  if (pa && ps2 && pa !== ps2) return 2;
  return 1;
}

// 扫码抽奖：在有效启用活动中抽一次
function drawPrize(code, scanLocation) {
  const today = new Date().toISOString().slice(0, 10);
  const now = new Date().toISOString().slice(0, 10);
  const campaign = db.prepare(`
    SELECT * FROM campaigns WHERE enabled=1 AND start_date<=? AND end_date>=?
    ORDER BY id DESC LIMIT 1
  `).get(today, now);
  if (!campaign) return null;

  // 该码是否已中过奖
  const already = db.prepare('SELECT 1 FROM prize_records WHERE item_code=? AND campaign_id=?').get(code, campaign.id);
  if (already) return null;

  const roll = Math.random() * 100;
  if (roll > campaign.win_rate) return null;

  let prizeValue = '';
  if (campaign.prize_type === 'red_packet') {
    const v = campaign.prize_max > campaign.prize_min
      ? (campaign.prize_min + Math.random() * (campaign.prize_max - campaign.prize_min)).toFixed(2)
      : campaign.prize_min.toFixed(2);
    prizeValue = v;
  } else if (campaign.prize_type === 'coupon') {
    prizeValue = campaign.prize_min > 0 ? `${campaign.prize_min}元` : campaign.prize_name;
  }

  db.prepare(`INSERT INTO prize_records (item_code, campaign_id, prize_type, prize_name, prize_value, scan_location)
    VALUES (?,?,?,?,?,?)`).run(code, campaign.id, campaign.prize_type, campaign.prize_name || '', prizeValue, scanLocation);

  return {
    prize_type: campaign.prize_type,
    prize_name: campaign.prize_name || '',
    prize_value: prizeValue,
    campaign_name: campaign.name
  };
}

// ===================== 串货预警中心 =====================

// 预警列表页（brand 只看自己品牌）
app.get('/alerts', requireRole('admin', 'brand', 'brand_staff'), (req, res) => {
  const scopeSet = brandScopeSet(req);
  const alerts = scopeSet === null
    ? db.prepare('SELECT * FROM alerts ORDER BY handled ASC, id DESC LIMIT 500').all()
    : db.prepare(`SELECT * FROM alerts WHERE brand_id IN (${brandSetValues(scopeSet).map(() => '?').join(',')}) ORDER BY handled ASC, id DESC LIMIT 500`).all(...brandSetValues(scopeSet));
  res.render('alerts', { alerts });
});

// 预警列表 API（brand 只看自己品牌）
app.get('/api/alerts', requireRole('admin', 'brand', 'brand_staff'), (req, res) => {
  const scopeSet = brandScopeSet(req);
  const scopeVals = scopeSet === null ? [] : brandSetValues(scopeSet);
  const scopePh = scopeVals.map(() => '?').join(',');
  const alerts = scopeSet === null
    ? db.prepare('SELECT * FROM alerts ORDER BY handled ASC, id DESC LIMIT 500').all()
    : db.prepare(`SELECT * FROM alerts WHERE brand_id IN (${scopePh}) ORDER BY handled ASC, id DESC LIMIT 500`).all(...scopeVals);
  const unread = scopeSet === null
    ? db.prepare('SELECT COUNT(*) as c FROM alerts WHERE handled=0').get().c
    : db.prepare(`SELECT COUNT(*) as c FROM alerts WHERE handled=0 AND brand_id IN (${scopePh})`).get(...scopeVals).c;
  res.json({ success: true, alerts, unread });
});

// 品牌方扫码查串货：扫码/输码查询自己品牌码的串货状态与历史扫码记录
app.get('/api/brand/check-code/:code', requireRole('admin', 'brand', 'brand_staff'), (req, res) => {
  const code = extractCode(req.params.code);
  if (!code) return res.json({ success: false, msg: '请输入溯源码' });
  const scopeSet = brandScopeSet(req);

  // 查箱码
  let target = null, codeType = '';
  const box = db.prepare(`
    SELECT b.*, p.name as product_name, p.spec as product_spec,
      COALESCE(b.brand_id, p.brand_id) as eff_brand_id, br.name as tenant_brand_name,
      d.name as distributor_name, d.region as distributor_region
    FROM boxes b
    LEFT JOIN products p ON b.product_id = p.id
    LEFT JOIN brands br ON br.id = COALESCE(b.brand_id, p.brand_id)
    LEFT JOIN distributors d ON b.distributor_id = d.id
    WHERE b.box_code = ?
  `).get(code);
  if (box) { codeType = 'box'; target = box; }
  else {
    const item = db.prepare(`
      SELECT i.*, b.box_code, p.name as product_name, p.spec as product_spec,
        COALESCE(i.brand_id, p.brand_id) as eff_brand_id, br.name as tenant_brand_name,
        d.name as distributor_name, d.region as distributor_region
      FROM items i
      LEFT JOIN boxes b ON i.box_id = b.id
      LEFT JOIN products p ON i.product_id = p.id
      LEFT JOIN brands br ON br.id = COALESCE(i.brand_id, p.brand_id)
      LEFT JOIN distributors d ON i.distributor_id = d.id
      WHERE i.item_code = ?
    `).get(code);
    if (item) { codeType = 'item'; target = item; }
  }

  if (!target) return res.json({ success: false, msg: '溯源码不存在' });

  // 品牌权限校验：只能查自己品牌的码（admin 可查全部）
  if (!brandInSet(scopeSet, target.eff_brand_id)) {
    return res.status(403).json({ success: false, code: 'NOT_YOUR_BRAND', msg: '该溯源码不属于你的品牌，无权查询' });
  }

  // 该码历史扫码记录（含串货标记）
  const scanLogs = db.prepare(`
    SELECT scan_location, is_diversion, scanned_at
    FROM scan_logs WHERE item_code=? OR box_code=?
    ORDER BY id DESC LIMIT 200
  `).all(code, code);

  const diversionLogs = scanLogs.filter(l => l.is_diversion > 0);
  const maxDiversion = diversionLogs.length ? Math.max(...diversionLogs.map(l => l.is_diversion)) : 0;

  logOperation(req, 'brand_check_diversion', codeType, code, `查询溯源码${code}串货状态`);

  res.json({
    success: true,
    code_type: codeType,
    code: code,
    box_code: codeType === 'box' ? target.box_code : (target.box_code || ''),
    item_code: codeType === 'item' ? target.item_code : '',
    product_name: target.product_name || '',
    product_spec: target.product_spec || '',
    status: target.status,
    status_text: target.status === 'invalid' ? '已作废' : !target.product_id ? '未绑定商品，尚未入库' : (target.status === 'shipped' || target.distributor_id != null ? '已发货' : '已绑定商品'),
    batch_no: target.batch_no || '',
    distributor_name: target.distributor_name || '',
    assigned_region: publicRegion(target.distributor_region),
    brand_name: target.tenant_brand_name || '',
    has_diversion: maxDiversion > 0,
    diversion_level: maxDiversion,
    scan_logs: scanLogs.map(l => ({
      location: l.scan_location || '',
      is_diversion: l.is_diversion,
      scanned_at: l.scanned_at || ''
    }))
  });
});

// 扫码地域分布（全国地图）：按省份聚合扫码数与串货数
app.get('/api/alerts/geo-map', requireRole('admin', 'brand', 'brand_staff'), (req, res) => {
  const scopeSet = brandScopeSet(req);
  const rows = scopeSet === null
    ? db.prepare('SELECT scan_location, latitude, longitude, is_diversion FROM scan_logs').all()
    : db.prepare(`SELECT scan_location, latitude, longitude, is_diversion FROM scan_logs WHERE brand_id IN (${brandSetValues(scopeSet).map(() => '?').join(',')})`).all(...brandSetValues(scopeSet));

  // 省份关键词 → 标准省名（覆盖 31 省级行政区）
  const PROVINCES = [
    '北京','天津','上海','重庆','河北','山西','辽宁','吉林','黑龙江','江苏','浙江','安徽','福建','江西','山东','河南','湖北','湖南','广东','海南','四川','贵州','云南','陕西','甘肃','青海','内蒙古','广西','西藏','宁夏','新疆','香港','澳门','台湾'
  ];
  function extractProvince(loc) {
    if (!loc) return null;
    const l = String(loc).trim();
    for (const p of PROVINCES) {
      if (l.includes(p)) return p;
    }
    return null;
  }

  const agg = {}; // province -> { total, diversion, points: [{name, value}] }
  rows.forEach(r => {
    const prov = extractProvince(r.scan_location);
    if (!prov) return;
    if (!agg[prov]) agg[prov] = { total: 0, diversion: 0, points: [] };
    agg[prov].total += 1;
    if (r.is_diversion) agg[prov].diversion += 1;
    // 有经纬度的点，用于地图上的散点定位
    if (r.latitude != null && r.longitude != null) {
      agg[prov].points.push({ name: r.scan_location || prov, value: [Number(r.longitude), Number(r.latitude)] });
    }
  });

  const list = Object.keys(agg).map(prov => ({
    name: prov,
    total: agg[prov].total,
    diversion: agg[prov].diversion,
    points: agg[prov].points
  }));

  res.json({ success: true, list, total: rows.length });
});

// 标记已处理
app.post('/api/alerts/:id/handle', requireRole('admin', 'brand', 'brand_staff'), (req, res) => {
  const scopeSet = brandScopeSet(req);
  const a = db.prepare('SELECT * FROM alerts WHERE id=?').get(req.params.id);
  if (!a) return res.json({ success: false, msg: '预警不存在' });
  if (!brandInSet(scopeSet, a.brand_id)) return res.json({ success: false, msg: '没有权限处理该预警' });
  db.prepare(`UPDATE alerts SET handled=1, handled_at=datetime('now','localtime') WHERE id=?`).run(req.params.id);
  res.json({ success: true });
});
// 全部标记已处理（brand 只处理自己品牌的）
app.post('/api/alerts/handle-all', requireRole('admin', 'brand', 'brand_staff'), (req, res) => {
  const scopeSet = brandScopeSet(req);
  if (scopeSet === null) {
    db.prepare(`UPDATE alerts SET handled=1, handled_at=datetime('now','localtime') WHERE handled=0`).run();
  } else {
    const vals = brandSetValues(scopeSet);
    db.prepare(`UPDATE alerts SET handled=1, handled_at=datetime('now','localtime') WHERE handled=0 AND brand_id IN (${vals.map(() => '?').join(',')})`).run(...vals);
  }
  res.json({ success: true });
});

// 删除预警仅限平台/品牌管理员；删除动作保留审计记录。
app.delete('/api/alerts/:id', requireRole('admin', 'brand'), (req, res) => {
  const scopeSet = brandScopeSet(req);
  const alert = db.prepare('SELECT * FROM alerts WHERE id=?').get(req.params.id);
  if (!alert || !brandInSet(scopeSet, alert.brand_id)) return res.status(404).json({ success: false, msg: '预警不存在' });
  db.prepare('DELETE FROM alerts WHERE id=?').run(alert.id);
  logOperation(req, 'delete_alert', 'alert', alert.id, `删除预警：${alert.item_code || '未知溯源码'}，级别 ${alert.level || 1}`);
  res.json({ success: true });
});

// ===================== 账号管理（admin） =====================

// 账号管理页（admin 看全部；brand 只看自己品牌的账号，不能管理 admin/brand 角色）
app.get('/users', requireRole('admin', 'brand'), (req, res) => {
  const scopeSet = brandScopeSet(req);
  const baseUserSql = `
    SELECT u.id, u.username, u.display_name, u.phone, u.role, u.distributor_id, u.factory_id, u.brand_id, u.enabled, u.created_at, u.last_login_at,
      d.name as distributor_name, f.name as factory_name, b.name as brand_name,
      (SELECT group_concat(bx.name, '、') FROM user_brands ub2 JOIN brands bx ON bx.id=ub2.brand_id WHERE ub2.user_id=u.id) AS brand_names
    FROM users u
    LEFT JOIN distributors d ON u.distributor_id = d.id
    LEFT JOIN factories f ON u.factory_id = f.id
    LEFT JOIN brands b ON u.brand_id = b.id
  `;
  let users;
  if (scopeSet === null) {
    users = db.prepare(baseUserSql + ' ORDER BY u.id').all();
  } else {
    const vals = brandSetValues(scopeSet);
    const ph = vals.map(() => '?').join(',');
    users = db.prepare(`${baseUserSql} WHERE u.brand_id IN (${ph}) OR EXISTS (SELECT 1 FROM user_brands ub3 WHERE ub3.user_id=u.id AND ub3.brand_id IN (${ph})) ORDER BY u.id`).all(...vals, ...vals);
  }
  const brandMap = {};
  db.prepare('SELECT user_id, brand_id FROM user_brands').all().forEach(r => {
    (brandMap[r.user_id] = brandMap[r.user_id] || []).push(r.brand_id);
  });
  users.forEach(u => { u.brand_ids = brandMap[u.id] || (u.brand_id ? [u.brand_id] : []); });
  const distributors = scopeSet === null
    ? db.prepare('SELECT id, name, region FROM distributors ORDER BY id DESC').all()
    : db.prepare('SELECT id, name, region FROM distributors ORDER BY id DESC').all();
  // 工厂的品牌集合（多品牌，口径同 factoryBrandSet：主品牌 ∪ factory_brands）。
  // 账号表单选「绑定工厂」后据此带出「归属品牌」，否则只能靠人工勾选。
  const factories = db.prepare('SELECT id, name, brand_id FROM factories WHERE enabled=1 ORDER BY id DESC').all();
  {
    const factoryBrandMap = {};
    db.prepare('SELECT factory_id, brand_id FROM factory_brands').all().forEach(r => {
      (factoryBrandMap[r.factory_id] = factoryBrandMap[r.factory_id] || []).push(Number(r.brand_id));
    });
    factories.forEach(f => {
      const set = new Set(factoryBrandMap[f.id] || []);
      if (f.brand_id) set.add(Number(f.brand_id));
      f.brand_ids = [...set];
    });
  }
  const invitations = scopeSet === null
    ? db.prepare(`
        SELECT i.id, i.code, i.role, i.note, i.status, i.used_by, i.used_at, i.created_at, b.name as brand_name, f.name as factory_name, u.display_name as user_name
        FROM invitations i LEFT JOIN brands b ON i.brand_id=b.id LEFT JOIN factories f ON i.factory_id=f.id LEFT JOIN users u ON i.used_by = u.username
        ORDER BY i.id DESC LIMIT 200
      `).all()
    : db.prepare(`
        SELECT i.id, i.code, i.role, i.note, i.status, i.used_by, i.used_at, i.created_at, b.name as brand_name, f.name as factory_name, u.display_name as user_name
        FROM invitations i LEFT JOIN brands b ON i.brand_id=b.id LEFT JOIN factories f ON i.factory_id=f.id LEFT JOIN users u ON i.used_by = u.username
        WHERE i.brand_id IN (${brandSetValues(scopeSet).map(() => '?').join(',')}) ORDER BY i.id DESC LIMIT 200
      `).all(...brandSetValues(scopeSet));
  // 账号表单的「归属品牌」是必填项：品牌方编辑者必须能选到自己权限内的品牌，
  // 否则下拉为空、前端必选校验会把品牌方管理员彻底挡住。仅返回其范围内的**启用**品牌。
  const brands = scopeSet === null
    ? db.prepare('SELECT id, name, contact, enabled, created_at FROM brands ORDER BY id').all()
    : db.prepare(`SELECT id, name, contact, enabled, created_at FROM brands
        WHERE enabled=1 AND id IN (${brandSetValues(scopeSet).map(() => '?').join(',')}) ORDER BY id`)
      .all(...brandSetValues(scopeSet));
  res.render('users', { users, distributors, factories, invitations: currentUser(req).role === readOnlyAccess.ROLE ? invitations.map(row => ({...row,code:'仅管理员可见'})) : invitations, brands, roleNames: ROLE_NAMES });
});

// 账号列表（同页面过滤规则）
app.get('/api/users', requireRole('admin', 'brand'), (req, res) => {
  const scope = brandScope(req);
  const scopeSet = brandScopeSet(req);
  const baseUserSql = `
    SELECT u.id, u.username, u.display_name, u.phone, u.role, u.distributor_id, u.factory_id, u.brand_id, u.enabled, u.created_at, u.last_login_at,
      d.name as distributor_name, f.name as factory_name, b.name as brand_name,
      (SELECT group_concat(bx.name, '、') FROM user_brands ub2 JOIN brands bx ON bx.id=ub2.brand_id WHERE ub2.user_id=u.id) AS brand_names
    FROM users u
    LEFT JOIN distributors d ON u.distributor_id = d.id
    LEFT JOIN factories f ON u.factory_id = f.id
    LEFT JOIN brands b ON u.brand_id = b.id
  `;
  let users;
  if (scopeSet === null) {
    users = db.prepare(baseUserSql + ' ORDER BY u.id').all();
  } else {
    const vals = brandSetValues(scopeSet);
    const placeholders = vals.map(() => '?').join(',');
    users = db.prepare(`${baseUserSql} WHERE u.brand_id IN (${placeholders}) OR EXISTS (SELECT 1 FROM user_brands ub3 WHERE ub3.user_id=u.id AND ub3.brand_id IN (${placeholders})) ORDER BY u.id`).all(...vals, ...vals);
  }
  const brandMap = {};
  db.prepare('SELECT user_id, brand_id FROM user_brands').all().forEach(r => {
    (brandMap[r.user_id] = brandMap[r.user_id] || []).push(r.brand_id);
  });
  users.forEach(u => { u.brand_ids = brandMap[u.id] || (u.brand_id ? [u.brand_id] : []); });
  res.json({ success: true, users });
});

// 写入/更新账号的品牌集合（多品牌）。
function applyUserBrands(userId, brandIds, scopeSet) {
  if (!Array.isArray(brandIds)) return null;
  const ids = [...new Set(brandIds.map(x => Number(x)).filter(x => Number.isInteger(x) && x > 0))];
  const final = scopeSet === null ? ids : ids.filter(x => brandInSet(scopeSet, x));
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM user_brands WHERE user_id=?').run(userId);
    const ins = db.prepare('INSERT OR IGNORE INTO user_brands (user_id, brand_id) VALUES (?,?)');
    final.forEach(bid => ins.run(userId, bid));
    const first = final[0] ?? null;
    if (first) db.prepare('UPDATE users SET brand_id=? WHERE id=?').run(first, userId);
  });
  tx();
  return final;
}

// 新建账号（admin 可建任意角色并指定品牌；brand 只能建本品牌的工厂/代理商/品牌方账号）
app.post('/api/users', requireRole('admin', 'brand'), (req, res) => {
  const { username, password, display_name, role, distributor_id, factory_id, brand_ids } = req.body;
  const phone = String(req.body.phone || '').trim();
  const scope = brandScope(req);
  const scopeSet = brandScopeSet(req);
  const uname = String(username || '').trim();
  if (!uname || !password) return res.json({ success: false, msg: '账号和密码不能为空' });
  if (!/^[a-zA-Z0-9_]{3,20}$/.test(uname)) return res.json({ success: false, msg: '账号需为3-20位字母/数字/下划线' });
  if (!passwordMeetsPolicy(password)) return res.json({ success: false, msg: PASSWORD_POLICY_MESSAGE });
  if (!ROLE_NAMES[role]) return res.json({ success: false, msg: '角色不合法' });
  if (scope !== null && !['factory', 'warehouse', 'distributor', 'brand_staff'].includes(role)) {
    return res.json({ success: false, msg: '品牌方只能创建工厂装箱/仓库/代理商/品牌工作账号' });
  }
  if (db.prepare('SELECT 1 FROM users WHERE username=?').get(uname)) return res.json({ success: false, msg: '该账号已存在' });
  // 品牌归属：brand 固定自己品牌；admin 按表单选择或从所绑实体带出
  let brand_id = scope !== null ? scope : (parseInt(req.body.brand_id) || null);
  let factoryFallbackBrandIds = [];   // factory 账号未勾选品牌时的回落集合（工厂多品牌）
  if (['brand', 'brand_staff', 'warehouse'].includes(role) && !brand_id) return res.json({ success: false, msg: '品牌方账号必须指定所属品牌' });
  if (brand_id && !db.prepare('SELECT 1 FROM brands WHERE id=? AND enabled=1').get(brand_id)) {
    return res.json({ success: false, msg: '所选品牌不存在或已停用' });
  }
  if (role === 'distributor') {
    if (!distributor_id) return res.json({ success: false, msg: '代理商账号必须绑定代理商' });
    const d = db.prepare('SELECT * FROM distributors WHERE id=?').get(distributor_id);
    if (!d) return res.json({ success: false, msg: '代理商不存在' });
    const distEditorScope = brandScopeSet(req);
    if (!distributorInScope(distEditorScope, d)) return res.json({ success: false, msg: '该代理商不属于你的品牌' });
    // 归属品牌必须落在编辑者范围内：多品牌代理商取「代理商品牌 ∩ 编辑者范围」，
    // 优先兼容主品牌（管理员 scope=null 时行为不变），否则取交集第一个。
    const distBrands = distributorBrandIdList(d);
    const sharedDistBrands = distEditorScope === null
      ? distBrands
      : distBrands.filter(x => brandInSet(distEditorScope, x));
    brand_id = (d.brand_id && sharedDistBrands.includes(Number(d.brand_id)))
      ? Number(d.brand_id)
      : (sharedDistBrands[0] || brand_id);
  }
  if (role === 'factory') {
    // 工厂端装箱子账号：人名 + 11位手机号 + 绑定工厂 三项必填
    if (!String(display_name || '').trim()) return res.json({ success: false, msg: '工厂账号必须填写人名' });
    if (!/^1\d{10}$/.test(phone)) return res.json({ success: false, msg: '工厂账号必须填写11位手机号' });
    if (!factory_id) return res.json({ success: false, msg: '工厂账号必须绑定工厂' });
    const f = db.prepare('SELECT * FROM factories WHERE id=? AND enabled=1').get(factory_id);
    if (!f) return res.json({ success: false, msg: '工厂不存在' });
    if (!brandInSet(brandScopeSet(req), f.brand_id)) return res.json({ success: false, msg: '该工厂不属于你的品牌' });
    // 归属品牌（可多选）：显式勾选的品牌优先（且必须在编辑者品牌集合内、品牌已启用），
    // 未勾选时回落到工厂主品牌，保持旧行为不变。
    const pickedFactoryBrands = Array.isArray(brand_ids)
      ? [...new Set(brand_ids.map(x => Number(x)).filter(x => Number.isInteger(x) && x > 0))]
      : [];
    const allowedFactoryBrands = scopeSet === null
      ? pickedFactoryBrands
      : pickedFactoryBrands.filter(x => brandInSet(scopeSet, x));
    if (allowedFactoryBrands.length) {
      const badBrand = allowedFactoryBrands.find(x => !db.prepare('SELECT 1 FROM brands WHERE id=? AND enabled=1').get(x));
      if (badBrand) return res.json({ success: false, msg: '所选品牌不存在或已停用' });
      brand_id = allowedFactoryBrands[0];
    } else {
      // 未勾选归属品牌：回落为「工厂的品牌集合」（多品牌），与工厂编辑口径一致。
      // 旧行为只取工厂主品牌，导致工厂配了多个品牌时账号仍然只有一个。
      factoryFallbackBrandIds = [...factoryBrandSet(factory_id)]
        .filter(x => scopeSet === null || brandInSet(scopeSet, x))
        .filter(x => db.prepare('SELECT 1 FROM brands WHERE id=? AND enabled=1').get(x));
      brand_id = factoryFallbackBrandIds[0] || f.brand_id || brand_id;
    }
  }
  const ins = db.prepare('INSERT INTO users (username, password_hash, display_name, phone, role, distributor_id, factory_id, brand_id) VALUES (?,?,?,?,?,?,?,?)')
    .run(uname, hashPassword(password), String(display_name || '').trim(), phone, role,
      role === 'distributor' ? distributor_id : null,
      role === 'factory' ? factory_id : null,
      brand_id || null);
  const newId = ins.lastInsertRowid;
  // 多品牌归属：品牌方账号（brand/brand_staff/warehouse）与工厂装箱账号（factory）支持多选；
  // 空数组不再落库，改为回落到主品牌单挂，避免"传空就清空品牌行"。
  const pickedBrandIds = Array.isArray(brand_ids)
    ? [...new Set(brand_ids.map(x => Number(x)).filter(x => Number.isInteger(x) && x > 0))]
    : [];
  if (pickedBrandIds.length && ['brand', 'brand_staff', 'warehouse', 'factory'].includes(role)) {
    applyUserBrands(newId, pickedBrandIds, scopeSet);
  } else if (role === 'factory' && factoryFallbackBrandIds.length) {
    // 工厂账号未显式勾选：落到工厂的品牌集合（多品牌）
    applyUserBrands(newId, factoryFallbackBrandIds, scopeSet);
  } else if (brand_id) {
    applyUserBrands(newId, [brand_id], scopeSet);
  }
  logOperation(req, 'create_user', 'user', uname, `账号「${uname}」（${ROLE_NAMES[role]}）已创建`);
  res.json({ success: true, msg: '账号已创建' });
});

// 工厂列表/新建（admin 手动管理工厂实体；brand 只能看/建自己品牌的工厂）
app.get('/api/factories', requireRole('admin', 'brand'), (req, res) => {
  const scope = brandScope(req);
  const scopeSet = brandScopeSet(req);
  const base = `SELECT f.id, f.name, f.contact, f.enabled, f.created_at, b.name as brand_name,
    (SELECT group_concat(bx.name, '、') FROM factory_brands fb2 JOIN brands bx ON bx.id=fb2.brand_id WHERE fb2.factory_id=f.id) AS brand_names
    FROM factories f LEFT JOIN brands b ON f.brand_id=b.id`;
  let factories;
  if (scopeSet === null) {
    factories = db.prepare(base + ' ORDER BY f.enabled DESC,f.id DESC').all();
  } else {
    const vals = brandSetValues(scopeSet);
    const placeholders = vals.map(() => '?').join(',');
    factories = db.prepare(`${base} WHERE f.brand_id IN (${placeholders}) OR EXISTS (SELECT 1 FROM factory_brands fb3 WHERE fb3.factory_id=f.id AND fb3.brand_id IN (${placeholders})) ORDER BY f.enabled DESC,f.id DESC`).all(...vals, ...vals);
  }
  const brandMap = {};
  db.prepare('SELECT factory_id, brand_id FROM factory_brands').all().forEach(r => {
    (brandMap[r.factory_id] = brandMap[r.factory_id] || []).push(r.brand_id);
  });
  factories.forEach(f => { f.brand_ids = brandMap[f.id] || (f.brand_id ? [f.brand_id] : []); });
  res.json({ success: true, factories });
});

// 写入/更新工厂的品牌集合（多品牌）。
function applyFactoryBrands(factoryId, brandIds, scopeSet) {
  if (!Array.isArray(brandIds)) return;
  const ids = [...new Set(brandIds.map(x => Number(x)).filter(x => Number.isInteger(x) && x > 0))];
  const final = scopeSet === null ? ids : ids.filter(x => brandInSet(scopeSet, x));
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM factory_brands WHERE factory_id=?').run(factoryId);
    const ins = db.prepare('INSERT OR IGNORE INTO factory_brands (factory_id, brand_id) VALUES (?,?)');
    final.forEach(bid => ins.run(factoryId, bid));
    // 兼容字段 factories.brand_id（主品牌）：已存在且仍在集合内就保持不变，
    // 否则编辑多品牌会静默改写旧口径，使既有产品与工厂品牌失配。
    const current = db.prepare('SELECT brand_id FROM factories WHERE id=?').get(factoryId)?.brand_id ?? null;
    const primary = (current && final.includes(Number(current))) ? Number(current) : (final[0] ?? null);
    if (primary) db.prepare('UPDATE factories SET brand_id=? WHERE id=?').run(primary, factoryId);
  });
  tx();
  return final;
}

app.post('/api/factories', requireRole('admin', 'brand'), (req, res) => {
  const name = String(req.body.name || '').trim();
  const contact = String(req.body.contact || '').trim();
  const scopeSet = brandScopeSet(req);
  if (!name) return res.json({ success: false, msg: '工厂名称不能为空' });
  let brandIds = Array.isArray(req.body.brand_ids)
    ? req.body.brand_ids.map(x => Number(x)).filter(x => Number.isInteger(x) && x > 0)
    : [];
  if (brandIds.length === 0) {
    const requested = parseInt(req.body.brand_id) || null;
    const single = scopeSet !== null
      ? (brandInSet(scopeSet, requested) ? requested : (brandSetValues(scopeSet)[0] ?? null))
      : requested;
    if (single) brandIds = [single];
  }
  if (scopeSet !== null) brandIds = brandIds.filter(x => brandInSet(scopeSet, x));
  if (brandIds.length === 0) return res.json({ success: false, msg: '请至少选择一个归属品牌' });
  const primaryBrand = brandIds[0];
  if (!db.prepare('SELECT 1 FROM brands WHERE id=? AND enabled=1').get(primaryBrand)) {
    return res.json({ success: false, msg: '所选品牌不存在或已停用' });
  }
  const r = db.prepare('INSERT INTO factories (name, contact, brand_id) VALUES (?,?,?)').run(name, contact, primaryBrand);
  applyFactoryBrands(r.lastInsertRowid, brandIds, scopeSet);
  res.json({ success: true, id: r.lastInsertRowid, msg: '工厂已创建' });
});

// 删除工厂：空工厂物理删除；有历史记录的工厂只停用归档，保留审计名称与收货归属。
// 编辑工厂：修改名称、联系人、归属品牌（多品牌）
app.put('/api/factories/:id', requireRole('admin', 'brand'), (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.json({ success: false, msg: '工厂不存在' });
  const f = db.prepare('SELECT * FROM factories WHERE id=?').get(id);
  if (!f) return res.json({ success: false, msg: '工厂不存在' });
  if (!brandInSet(brandScopeSet(req), f.brand_id)) return res.json({ success: false, msg: '没有权限操作该工厂' });

  const name = req.body.name !== undefined ? String(req.body.name || '').trim() : f.name;
  const contact = req.body.contact !== undefined ? String(req.body.contact || '').trim() : f.contact;
  if (!name) return res.json({ success: false, msg: '工厂名称不能为空' });

  const scopeSet = brandScopeSet(req);
  let brandIds;
  if (req.body.brand_ids !== undefined && Array.isArray(req.body.brand_ids)) {
    brandIds = req.body.brand_ids.map(x => Number(x)).filter(x => Number.isInteger(x) && x > 0);
  } else if (req.body.brand_id !== undefined) {
    const single = parseInt(req.body.brand_id);
    brandIds = single ? [single] : [];
  } else {
    brandIds = (f.brand_id ? [f.brand_id] : []);
  }
  if (scopeSet !== null) brandIds = brandIds.filter(x => brandInSet(scopeSet, x));
  if (brandIds.length === 0) return res.json({ success: false, msg: '请至少选择一个归属品牌' });
  const primaryBrand = brandIds[0];
  if (!db.prepare('SELECT 1 FROM brands WHERE id=? AND enabled=1').get(primaryBrand)) {
    return res.json({ success: false, msg: '所选品牌不存在或已停用' });
  }

  // 移除仍被产品引用的品牌会让这些产品的授权关系失效（并让启动回填无从修复），必须拦截。
  const attachedBrandIds = db.prepare(`SELECT p.brand_id AS brand_id FROM product_factories pf
        JOIN products p ON p.id=pf.product_id WHERE pf.factory_id=?
      UNION
      SELECT p.brand_id AS brand_id FROM products p
        WHERE p.factory_id=? AND p.brand_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM product_factories pf2 WHERE pf2.product_id=p.id)`).all(id, id)
    .map(row => Number(row.brand_id)).filter(brandId => brandId && !brandIds.includes(brandId));
  if (attachedBrandIds.length) {
    const names = attachedBrandIds.map(brandId => db.prepare('SELECT name FROM brands WHERE id=?').get(brandId)?.name || `#${brandId}`).join('、');
    return res.status(409).json({
      success: false,
      code: 'FACTORY_BRAND_HAS_PRODUCTS',
      msg: `品牌「${names}」下仍有产品归属该工厂，不能移除该品牌。请先修改这些产品的归属工厂，或先改品牌归属。`
    });
  }
  // 注意：这里不能写 brand_id —— 先写再让 applyFactoryBrands 读「原主品牌」只会读到刚写进去的值。
  db.prepare('UPDATE factories SET name=?, contact=? WHERE id=?').run(name, contact, id);
  applyFactoryBrands(id, brandIds, scopeSet);
  logOperation(req, 'edit_factory', 'factory', id, `编辑工厂「${name}」`);
  res.json({ success: true, msg: '工厂信息已更新' });
});

// 启用/停用工厂（enabled: true/false 或 action: enable/disable）
app.post('/api/factories/:id/toggle', requireRole('admin', 'brand'), (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.json({ success: false, msg: '工厂不存在' });
  const f = db.prepare('SELECT * FROM factories WHERE id=?').get(id);
  if (!f) return res.json({ success: false, msg: '工厂不存在' });
  if (!brandInSet(brandScopeSet(req), f.brand_id)) return res.json({ success: false, msg: '没有权限操作该工厂' });

  const action = req.body && (req.body.action || (req.body.enabled === true || req.body.enabled === 1 ? 'disable' : req.body.enabled === false || req.body.enabled === 0 ? 'enable' : null));
  const toEnable = req.body && req.body.action === 'enable' ? true : (req.body && req.body.enabled === true ? true : null);
  const targetEnabled = toEnable === true ? 1 : toEnable === false ? 0 : (f.enabled ? 0 : 1);

  // 停用前校验：仍有在库实物时禁止停用
  if (!targetEnabled) {
    const activeItems = db.prepare(`SELECT COUNT(*) c FROM items WHERE receipt_factory_id=? AND status IN ('scanned','packing') AND boxed_at IS NOT NULL`).get(id).c;
    const activeBoxes = db.prepare(`SELECT COUNT(*) c FROM boxes WHERE receipt_factory_id=? AND status IN ('in_stock','packing') AND (item_count>0 OR EXISTS (SELECT 1 FROM items i WHERE i.box_id=boxes.id))`).get(id).c;
    if (activeItems || activeBoxes) {
      return res.status(409).json({ success: false, code: 'FACTORY_HAS_ACTIVE_STOCK', msg: `该工厂仍有 ${activeBoxes} 个在库箱码、${activeItems} 个在库子码，请先完成发货或取消入库后再停用。` });
    }
  }

  db.prepare('UPDATE factories SET enabled=? WHERE id=?').run(targetEnabled ? 1 : 0, id);
  logOperation(req, targetEnabled ? 'enable_factory' : 'disable_factory', 'factory', id, `${targetEnabled ? '启用' : '停用'}工厂「${f.name}」`);
  res.json({ success: true, enabled: !!targetEnabled, msg: `工厂「${f.name}」已${targetEnabled ? '启用' : '停用'}` });
});

app.delete('/api/factories/:id', requireRole('admin', 'brand'), (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.json({ success: false, msg: '工厂不存在' });
  const f = db.prepare('SELECT * FROM factories WHERE id=?').get(id);
  if (!f) return res.json({ success: false, msg: '工厂不存在' });
  if (!brandInSet(brandScopeSet(req), f.brand_id)) return res.json({ success: false, msg: '没有权限操作该工厂' });
  if (!f.enabled) return res.json({ success: true, archived: true, msg: `工厂「${f.name}」已处于停用归档状态` });
  const userCount = db.prepare('SELECT COUNT(*) as c FROM users WHERE factory_id=?').get(id).c;
  if (userCount > 0) {
    return res.json({ success: false, msg: `该工厂下还有 ${userCount} 个账号，请先到账号管理中解除绑定后再删除` });
  }
  const productCount = db.prepare(`SELECT COUNT(DISTINCT p.id) as c FROM products p
    LEFT JOIN product_factories pf ON pf.product_id=p.id
    WHERE pf.factory_id=? OR (pf.product_id IS NULL AND p.factory_id=?)`).get(id, id).c;
  const boxCount = db.prepare(`SELECT COUNT(DISTINCT b.id) as c FROM boxes b JOIN products p ON p.id=b.product_id
    LEFT JOIN product_factories pf ON pf.product_id=p.id
    WHERE pf.factory_id=? OR (pf.product_id IS NULL AND p.factory_id=?)`).get(id, id).c;
  const itemCount = db.prepare(`SELECT COUNT(DISTINCT i.id) as c FROM items i JOIN products p ON p.id=i.product_id
    LEFT JOIN product_factories pf ON pf.product_id=p.id
    WHERE pf.factory_id=? OR (pf.product_id IS NULL AND p.factory_id=?)`).get(id, id).c;
  const activeItems = db.prepare(`SELECT COUNT(*) c FROM items
    WHERE receipt_factory_id=? AND status IN ('scanned','packing') AND boxed_at IS NOT NULL`).get(id).c;
  const activeBoxes = db.prepare(`SELECT COUNT(*) c FROM boxes
    WHERE receipt_factory_id=? AND status IN ('in_stock','packing')
      AND (item_count>0 OR EXISTS (SELECT 1 FROM items i WHERE i.box_id=boxes.id))`).get(id).c;
  if (activeItems || activeBoxes) {
    return res.status(409).json({
      success: false,
      code: 'FACTORY_HAS_ACTIVE_STOCK',
      msg: `该工厂仍有 ${activeBoxes} 个在库箱码、${activeItems} 个在库子码，请先完成发货、取消入库或工厂交接，不能删除或停用。`
    });
  }
  const receiptHistory = db.prepare(`SELECT
      (SELECT COUNT(*) FROM boxes WHERE receipt_factory_id=?) +
      (SELECT COUNT(*) FROM items WHERE receipt_factory_id=?) +
      (SELECT COUNT(*) FROM pack_records WHERE COALESCE(receipt_factory_id,factory_id)=?) AS c`).get(id, id, id).c;
  const shouldArchive = receiptHistory > 0;
  const tx = db.transaction(() => {
    const primaryProducts = db.prepare('SELECT id FROM products WHERE factory_id=?').all(id);
    db.prepare('DELETE FROM product_factories WHERE factory_id=?').run(id);
    const nextFactory = db.prepare('SELECT factory_id FROM product_factories WHERE product_id=? ORDER BY created_at,factory_id LIMIT 1');
    const updatePrimary = db.prepare('UPDATE products SET factory_id=? WHERE id=?');
    primaryProducts.forEach(product => updatePrimary.run(nextFactory.get(product.id)?.factory_id || null, product.id));
    if (shouldArchive) db.prepare('UPDATE factories SET enabled=0 WHERE id=?').run(id);
    else db.prepare('DELETE FROM factories WHERE id=?').run(id);
  });
  tx();
  const action = shouldArchive ? 'archive_factory' : 'delete_factory';
  const detail = shouldArchive
    ? `工厂「${f.name}」已停用归档（解除 ${productCount} 个产品关联；保留 ${receiptHistory} 条历史收货/装箱引用）`
    : `空工厂「${f.name}」已删除（解除 ${productCount} 个产品关联；涉及 ${boxCount} 箱码/${itemCount} 子码）`;
  logOperation(req, action, 'factory', id, detail);
  res.json({ success: true, archived: shouldArchive, msg: shouldArchive ? `工厂「${f.name}」已停用归档，历史记录完整保留` : `空工厂「${f.name}」已删除` });
});

// 修改账号（重置密码 / 启停 / 改角色；brand 只能操作本品牌账号且不能改成 admin/brand）
app.put('/api/users/:id', requireRole('admin', 'brand'), (req, res) => {
  const id = req.params.id;
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(id);
  if (!user) return res.json({ success: false, msg: '账号不存在' });
  const scope = brandScope(req);
  if (!brandInSet(brandScopeSet(req), user.brand_id)) return res.json({ success: false, msg: '没有权限操作该账号' });
  const { password, display_name, role, distributor_id, factory_id, enabled, brand_id, brand_ids } = req.body;
  if (role !== undefined && !ROLE_NAMES[role]) return res.json({ success: false, msg: '账号角色无效' });
  // 品牌管理员编辑平台/品牌管理员账号时角色保持不变；其余情况使用请求角色。
  const keepRole = scope !== null && ['admin', 'brand'].includes(user.role);
  const newRole = keepRole ? user.role : (role || user.role);
  if (user.username === 'admin' && newRole !== 'admin') return res.json({ success: false, msg: '内置 admin 账号不能降级' });
  if (scope !== null && !keepRole && !['factory', 'warehouse', 'distributor'].includes(newRole)) {
    return res.json({ success: false, msg: '品牌管理员不能设置该角色' });
  }

  let newBrandId = user.brand_id;
  let newDistributorId = null;
  let newFactoryId = null;
  let factoryFallbackBrandIds = [];   // factory 账号未勾选品牌时的回落集合（工厂多品牌）
  if (['brand', 'brand_staff', 'warehouse'].includes(newRole)) {
    // 多品牌归属：显式请求的品牌若在编辑者集合内就用它，否则回落到集合第一个（主品牌）。
    const editorSet = brandScopeSet(req);
    const requested = (brand_id !== undefined && brand_id !== null && brand_id !== '') ? (parseInt(brand_id) || null) : null;
    if (editorSet !== null) {
      newBrandId = brandInSet(editorSet, requested) ? requested : (brandSetValues(editorSet)[0] || null);
    } else if (requested) {
      newBrandId = requested;
    }
    if (!newBrandId || !db.prepare('SELECT 1 FROM brands WHERE id=? AND enabled=1').get(newBrandId)) {
      return res.json({ success: false, msg: '品牌方账号必须绑定有效品牌' });
    }
  } else if (newRole === 'distributor') {
    newDistributorId = parseInt(distributor_id) || user.distributor_id || null;
    const distributor = newDistributorId ? db.prepare('SELECT id,brand_id FROM distributors WHERE id=?').get(newDistributorId) : null;
    if (!distributor) return res.json({ success: false, msg: '代理商账号必须绑定有效代理商' });
    const distEditorScope = brandScopeSet(req);
    if (!distributorInScope(distEditorScope, distributor)) return res.status(403).json({ success: false, code: 'ACCOUNT_TENANT_FORBIDDEN', msg: '不能把账号绑定到其他品牌的代理商' });
    // 同 POST /api/users：归属品牌取「代理商品牌 ∩ 编辑者范围」，优先兼容主品牌。
    const distBrands = distributorBrandIdList(distributor);
    const sharedDistBrands = distEditorScope === null
      ? distBrands
      : distBrands.filter(x => brandInSet(distEditorScope, x));
    newBrandId = (distributor.brand_id && sharedDistBrands.includes(Number(distributor.brand_id)))
      ? Number(distributor.brand_id)
      : (sharedDistBrands[0] || null);
    if (!newBrandId) return res.status(403).json({ success: false, code: 'ACCOUNT_TENANT_FORBIDDEN', msg: '不能把账号绑定到其他品牌的代理商' });
  } else if (newRole === 'factory') {
    newFactoryId = parseInt(factory_id) || user.factory_id || null;
    const factory = newFactoryId ? db.prepare('SELECT id,brand_id FROM factories WHERE id=? AND enabled=1').get(newFactoryId) : null;
    if (!factory || !factory.brand_id) return res.json({ success: false, msg: '工厂账号必须绑定已归属品牌的有效工厂' });
    if (!brandInSet(brandScopeSet(req), factory.brand_id)) return res.status(403).json({ success: false, code: 'ACCOUNT_TENANT_FORBIDDEN', msg: '不能把账号绑定到其他品牌的工厂' });
    // 归属品牌（可多选）：显式勾选优先（须在编辑者集合内、品牌已启用），否则回落到工厂主品牌。
    const factoryEditorSet = brandScopeSet(req);
    const pickedFactoryBrands = Array.isArray(brand_ids)
      ? [...new Set(brand_ids.map(x => Number(x)).filter(x => Number.isInteger(x) && x > 0))]
      : [];
    const allowedFactoryBrands = factoryEditorSet === null
      ? pickedFactoryBrands
      : pickedFactoryBrands.filter(x => brandInSet(factoryEditorSet, x));
    if (allowedFactoryBrands.length) {
      const badBrand = allowedFactoryBrands.find(x => !db.prepare('SELECT 1 FROM brands WHERE id=? AND enabled=1').get(x));
      if (badBrand) return res.json({ success: false, msg: '所选品牌不存在或已停用' });
      newBrandId = allowedFactoryBrands[0];
    } else {
      // 未勾选归属品牌：回落为「工厂的品牌集合」（多品牌），与工厂编辑口径一致
      factoryFallbackBrandIds = [...factoryBrandSet(newFactoryId)]
        .filter(x => factoryEditorSet === null || brandInSet(factoryEditorSet, x))
        .filter(x => db.prepare('SELECT 1 FROM brands WHERE id=? AND enabled=1').get(x));
      newBrandId = factoryFallbackBrandIds[0] || factory.brand_id;
    }
  } else if (newRole === 'admin') {
    if (scope !== null) return res.status(403).json({ success: false, msg: '品牌管理员不能设置平台管理员' });
    newBrandId = null;
  }

  const newPhone = req.body.phone === undefined ? String(user.phone || '') : String(req.body.phone || '').trim();
  if (newRole === 'factory' && !/^1\d{10}$/.test(newPhone)) return res.json({ success: false, msg: '工厂账号必须填写11位手机号' });
  if (password !== undefined && String(password).length > 0 && !passwordMeetsPolicy(password)) {
    return res.json({ success: false, msg: PASSWORD_POLICY_MESSAGE });
  }
  const newEnabled = enabled === undefined ? Number(user.enabled) : (enabled ? 1 : 0);
  if (user.username === 'admin' && !newEnabled) return res.json({ success: false, msg: '内置 admin 账号不能停用' });

  // 所有校验完成后一次提交，避免后续字段失败时留下“改了一半”的账号。
  const update = db.transaction(() => db.prepare(`UPDATE users SET password_hash=?,display_name=?,phone=?,role=?,distributor_id=?,factory_id=?,brand_id=?,enabled=? WHERE id=?`)
    .run(password !== undefined && String(password).length > 0 ? hashPassword(password) : user.password_hash,
      display_name === undefined ? user.display_name : String(display_name).trim(), newPhone, newRole,
      newDistributorId, newFactoryId, newBrandId, newEnabled, id));
  update();
  // 多品牌归属：品牌方账号与工厂装箱账号都支持多选；空数组不清空，回落为主品牌。
  const pickedIds = Array.isArray(brand_ids)
    ? [...new Set(brand_ids.map(x => Number(x)).filter(x => Number.isInteger(x) && x > 0))]
    : [];
  if (['brand', 'brand_staff', 'warehouse', 'factory'].includes(newRole)) {
    if (pickedIds.length) {
      applyUserBrands(Number(id), pickedIds, brandScopeSet(req));
    } else if (newRole === 'factory' && factoryFallbackBrandIds.length) {
      // 工厂账号未显式勾选：落到工厂的品牌集合（多品牌）
      applyUserBrands(Number(id), factoryFallbackBrandIds, brandScopeSet(req));
    } else if (newBrandId) {
      applyUserBrands(Number(id), [newBrandId], brandScopeSet(req));
    }
  }
  res.json({ success: true, msg: '账号已更新' });
});

// 删除账号
app.delete('/api/users/:id', requireRole('admin', 'brand'), (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id);
  if (!user) return res.json({ success: false, msg: '账号不存在' });
  if (user.username === 'admin') return res.json({ success: false, msg: '内置 admin 账号不能删除' });
  if (!brandInSet(brandScopeSet(req), user.brand_id)) return res.json({ success: false, msg: '没有权限删除该账号' });
  db.prepare('DELETE FROM users WHERE id=?').run(user.id);
  res.json({ success: true, msg: '账号已删除' });
});

// ===================== 个人资料 / 修改密码 =====================

app.get('/profile', requireLogin, (req, res) => {
  const profileUser = { ...req.session.user };
  if (profileUser.role === 'factory') {
    profileUser.factory_name = db.prepare('SELECT name FROM factories WHERE id=?').get(profileUser.factory_id)?.name || '未配置';
    profileUser.responsible_brand_name = brandNamesByIds(factoryPackBrands(req, profileUser.factory_id))
      .map(row => row.name).join('、') || '未配置';
  }
  res.render('profile', { user: profileUser, roleNames: ROLE_NAMES });
});

app.post('/api/profile/password/verify', requireLogin, (req, res) => {
  const user = db.prepare('SELECT password_hash FROM users WHERE id=?').get(req.session.user.id);
  const valid = !!user && verifyPassword(String(req.body.old_password || ''), user.password_hash);
  if (!valid) return res.status(400).json({ success: false, msg: '原密码错误' });
  res.json({ success: true });
});

app.post('/api/profile/password', requireLogin, (req, res) => {
  const { old_password, new_password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(req.session.user.id);
  if (!user || !verifyPassword(String(old_password || ''), user.password_hash)) {
    return res.json({ success: false, msg: '原密码错误' });
  }
  if (!passwordMeetsPolicy(new_password)) return res.json({ success: false, msg: PASSWORD_POLICY_MESSAGE });
  db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hashPassword(new_password), user.id);
  res.json({ success: true, msg: '密码已修改' });
});

// ===================== 代理商自助端 =====================

app.get('/portal', requireRole('distributor', 'admin', 'brand'), (req, res) => {
  // admin/brand 可带 ?distributor_id= 查看任意代理商视角（brand 限本品牌）
  const scopeSet = brandScopeSet(req);
  const did = req.session.user.role === 'distributor'
    ? req.session.user.distributor_id
    : (parseInt(req.query.distributor_id) || null);
  if (!did) return res.status(400).send('缺少代理商参数，<a href="/distributors">返回代理商管理</a>');
  const distributor = db.prepare('SELECT * FROM distributors WHERE id=?').get(did);
  if (!distributor) return res.status(404).send('代理商不存在');
  if (!distributorInScope(scopeSet, distributor)) return res.status(403).send('该代理商不属于你的品牌');

  // 该代理商的品牌集合：它的扫码记录可能横跨匹配到的多个品牌，
  // 只按兼容单字段 brand_id 统计会把其他品牌的记录漏掉。
  const distBrandIds = distributorBrandIdList(distributor);
  const distBrandPh = distBrandIds.map(() => '?').join(',');
  const stats = {
    boxes: db.prepare('SELECT COUNT(*) as c FROM boxes WHERE distributor_id=?').get(did).c,
    items: db.prepare('SELECT COUNT(*) as c FROM items WHERE distributor_id=?').get(did).c,
    scanned: db.prepare('SELECT COUNT(*) as c FROM items WHERE distributor_id=? AND scanned_at IS NOT NULL').get(did).c,
    diversions: distBrandIds.length
      ? db.prepare(`SELECT COUNT(*) as c FROM scan_logs WHERE is_diversion>0 AND distributor_name=? AND brand_id IN (${distBrandPh})`).get(distributor.name, ...distBrandIds).c
      : 0
  };
  const boxes = db.prepare(`
    SELECT b.*, p.name as product_name,
      (SELECT COUNT(*) FROM items i WHERE i.box_id=b.id AND i.scanned_at IS NOT NULL) as scanned_count
    FROM boxes b LEFT JOIN products p ON b.product_id=p.id
    WHERE b.distributor_id=? ORDER BY b.shipped_at DESC LIMIT 200
  `).all(did);
  const scans = distBrandIds.length
    ? db.prepare(`
    SELECT * FROM scan_logs WHERE distributor_name=? AND brand_id IN (${distBrandPh}) ORDER BY id DESC LIMIT 100
  `).all(distributor.name, ...distBrandIds)
    : [];
  res.render('portal', { distributor, stats, boxes, scans, isSelf: req.session.user.role === 'distributor' });
});

// ===================== 数据库备份 =====================

const backupDir = path.join(__dirname, 'data', 'backups');
function secureBackupDirectory() {
  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(backupDir, 0o700);
}

// 立即备份并下载（admin，POST 防止跨站 GET 触发写入）
app.post('/api/backup/download', requireRole('admin'), wrap(async (req, res) => {
  secureBackupDirectory();
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
  const file = path.join(backupDir, `traceability-${stamp}.db`);
  await db.backup(file);
  fs.chmodSync(file, 0o600);
  res.download(file, `溯源系统备份-${stamp}.db`, (err) => {
    if (err && !res.headersSent) res.status(500).json({ success: false, msg: '备份下载失败' });
  });
}));
app.get('/api/backup/download', requireRole('admin'), (req, res) => {
  res.setHeader('Allow', 'POST');
  res.status(405).json({ success: false, code: 'METHOD_NOT_ALLOWED', msg: '请使用备份按钮创建备份' });
});

// 产品授权上传：只允许产品所属租户的管理角色上传，文件随后需通过 media 接口绑定。
app.post('/api/products/:id/upload-images', requireRole('admin', 'brand', 'brand_staff'), (req, res) => {
  const product = scopedProduct(req, req.params.id);
  if (!product) return res.status(404).json({ success: false, msg: '产品不存在' });
  productImageUpload.array('files', 6)(req, res, async err => {
    if (err) {
      removeUploadedFiles(req.files);
      return res.status(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ success: false, msg: err.code === 'LIMIT_FILE_SIZE' ? '单张图片不能超过5MB' : `图片上传失败：${err.message}` });
    }
    if (!req.files?.length) return res.status(400).json({ success: false, msg: '请选择 JPEG、PNG 或 WebP 图片' });
    if (req.files.some(file => !uploadMagicMatches(file))) {
      removeUploadedFiles(req.files);
      return res.status(415).json({ success: false, code: 'INVALID_FILE_CONTENT', msg: '图片内容与文件类型不一致' });
    }
    const normalized = [];
    try {
      for (const file of req.files) normalized.push(await normalizeProductImage(file));
    } catch (error) {
      removeUploadedFiles(normalized);
      removeUploadedFiles(req.files);
      const pixels = error.code === 'INVALID_IMAGE_DIMENSIONS' || /pixel|dimension|Input image exceeds/i.test(error.message);
      return res.status(422).json({ success: false, code: pixels ? 'IMAGE_PIXEL_LIMIT' : 'IMAGE_DECODE_FAILED', msg: pixels ? '图片像素不能超过4000万且尺寸必须有效' : '图片解码或规范化失败' });
    }
    logOperation(req, 'upload_product_media', 'product', product.id, `上传并规范化产品图片 ${normalized.length} 张`);
    res.status(201).json({ success: true, urls: normalized.map(file => file.url), format: 'webp', max_dimension: PRODUCT_IMAGE_MAX_DIMENSION });
  });
});

// ===== 检测报告（按产品挂报告图片，消费者验证页展示） =====

// 列出产品的检测报告（含空批次）
app.get('/api/products/:id/reports', requireRole('admin', 'brand', 'brand_staff', 'factory'), (req, res) => {
  const product = scopedProduct(req, req.params.id);
  if (!product) return res.status(404).json({ success: false, msg: '产品不存在' });
  const reports = db.prepare('SELECT id, batch_no, url, title, created_at FROM product_reports WHERE brand_id=? AND product_id=? ORDER BY batch_no DESC, sort_order, id').all(product.brand_id, product.id);
  res.json({ success: true, reports });
});

// 上传检测报告图片（复用产品图片上传的规范化）
app.post('/api/products/:id/reports', requireRole('admin', 'brand', 'brand_staff'), (req, res) => {
  const product = scopedProduct(req, req.params.id);
  if (!product) return res.status(404).json({ success: false, msg: '产品不存在' });
  const batch_no = cleanText(req.body.batch_no || req.query.batch_no, 64) || '';
  productImageUpload.array('files', 9)(req, res, async err => {
    if (err) {
      removeUploadedFiles(req.files);
      return res.status(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ success: false, msg: err.code === 'LIMIT_FILE_SIZE' ? '单张图片不能超过5MB' : `报告上传失败：${err.message}` });
    }
    if (!req.files?.length) return res.status(400).json({ success: false, msg: '请选择 JPEG、PNG 或 WebP 图片' });
    if (req.files.some(file => !uploadMagicMatches(file))) {
      removeUploadedFiles(req.files);
      return res.status(415).json({ success: false, code: 'INVALID_FILE_CONTENT', msg: '图片内容与文件类型不一致' });
    }
    const urls = [];
    try {
      for (const file of req.files) urls.push((await normalizeProductImage(file)).url);
    } catch (error) {
      removeUploadedFiles(urls); removeUploadedFiles(req.files);
      return res.status(422).json({ success: false, msg: '图片解码或规范化失败' });
    }
    const insert = db.prepare('INSERT INTO product_reports (brand_id, product_id, batch_no, url, title, sort_order, created_by) VALUES (?,?,?,?,?,?,?)');
    const createdBy = currentUser(req)?.id || null;
    let seq = db.prepare('SELECT COALESCE(MAX(sort_order),0) as m FROM product_reports WHERE brand_id=? AND product_id=?').get(product.brand_id, product.id).m;
    const inserted = [];
    for (const url of urls) {
      seq += 1;
      const r = insert.run(product.brand_id, product.id, batch_no, url, '', seq, createdBy);
      inserted.push({ id: r.lastInsertRowid, batch_no, url });
    }
    logOperation(req, 'upload_product_report', 'product', product.id, `上传检测报告 ${urls.length} 张（批次 ${batch_no || '未填'}）`);
    res.status(201).json({ success: true, reports: inserted });
  });
});

// 删除检测报告
app.delete('/api/reports/:id', requireRole('admin', 'brand', 'brand_staff'), (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ success: false, msg: '无效的报告 ID' });
  const report = db.prepare('SELECT * FROM product_reports WHERE id=?').get(id);
  if (!report) return res.status(404).json({ success: false, msg: '报告不存在' });
  const product = db.prepare('SELECT * FROM products WHERE id=?').get(report.product_id);
  if (!product || !brandInSet(brandScopeSet(req), product.brand_id)) return res.status(403).json({ success: false, msg: '没有权限操作该报告' });
  db.prepare('DELETE FROM product_reports WHERE id=?').run(id);
  logOperation(req, 'delete_product_report', 'product', product.id, '删除检测报告');
  res.json({ success: true, msg: '报告已删除' });
});

// 消费者端：公开检测报告（供验证页展示，无需登录）
app.get('/api/public/reports/:code', (req, res) => {
  const code = String(req.params.code || '');
  const item = db.prepare('SELECT * FROM items WHERE item_code=?').get(code);
  const box = item ? null : db.prepare('SELECT * FROM boxes WHERE box_code=?').get(code);
  let product = null;
  if (item && item.product_id) product = db.prepare('SELECT * FROM products WHERE id=?').get(item.product_id);
  if (!product && box && box.product_id) product = db.prepare('SELECT * FROM products WHERE id=?').get(box.product_id);
  if (!product) return res.json({ success: true, reports: [] });
  const reports = db.prepare('SELECT id, batch_no, url, title FROM product_reports WHERE product_id=? ORDER BY batch_no DESC, sort_order, id').all(product.id);
  res.json({ success: true, reports, product_name: product.name });
});

// 备份列表（admin）
app.get('/api/backups', requireRole('admin'), (req, res) => {
  let files = [];
  try {
    secureBackupDirectory();
    files = fs.readdirSync(backupDir).filter(f => f.endsWith('.db') && fs.lstatSync(path.join(backupDir, f)).isFile())
      .map(f => {
        const st = fs.statSync(path.join(backupDir, f));
        return { name: f, size: st.size, created_at: st.mtime.toISOString().replace('T', ' ').slice(0, 19) };
      }).sort((a, b) => b.name.localeCompare(a.name));
  } catch (e) {}
  res.json({ success: true, backups: files });
});
// 下载指定备份
app.get('/api/backups/download/:name', requireRole('admin'), (req, res) => {
  const name = String(req.params.name || '');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.db$/.test(name)) return res.status(400).json({ success: false, msg: '文件名不合法' });
  const file = path.join(backupDir, name);
  if (!fs.existsSync(file) || !fs.lstatSync(file).isFile()) return res.status(404).json({ success: false, msg: '备份不存在' });
  res.download(file, name);
});

// --- 统计 API ---
app.get('/api/stats', requireRole('admin', 'brand', 'brand_staff'), (req, res) => {
  const scopeSet = brandScopeSet(req);
  if (scopeSet === null) {
    const stats = {
      total_boxes: db.prepare('SELECT COUNT(*) as c FROM boxes').get().c,
      total_items: db.prepare('SELECT COUNT(*) as c FROM items').get().c,
      shipped_boxes: db.prepare("SELECT COUNT(*) as c FROM boxes WHERE status='shipped'").get().c,
      scanned_items: db.prepare('SELECT COUNT(*) as c FROM items WHERE scanned_at IS NOT NULL').get().c,
      diversions: db.prepare('SELECT COUNT(*) as c FROM scan_logs WHERE is_diversion>0').get().c,
      total_scans: db.prepare('SELECT COUNT(*) as c FROM scan_logs').get().c,
    };
    return res.json({ success: true, stats });
  }
  const scopeVals = brandSetValues(scopeSet);
  const scopePh = scopeVals.map(() => '?').join(',');
  const stats = {
    total_boxes: db.prepare(`SELECT COUNT(*) as c FROM boxes b JOIN products p ON b.product_id=p.id WHERE p.brand_id IN (${scopePh})`).get(...scopeVals).c,
    total_items: db.prepare(`SELECT COUNT(*) as c FROM items i JOIN products p ON i.product_id=p.id WHERE p.brand_id IN (${scopePh})`).get(...scopeVals).c,
    shipped_boxes: db.prepare(`SELECT COUNT(*) as c FROM boxes b JOIN products p ON b.product_id=p.id WHERE b.status='shipped' AND p.brand_id IN (${scopePh})`).get(...scopeVals).c,
    scanned_items: db.prepare(`SELECT COUNT(*) as c FROM items i JOIN products p ON i.product_id=p.id WHERE i.scanned_at IS NOT NULL AND p.brand_id IN (${scopePh})`).get(...scopeVals).c,
    diversions: db.prepare(`SELECT COUNT(*) as c FROM scan_logs WHERE is_diversion>0 AND brand_id IN (${scopePh})`).get(...scopeVals).c,
    total_scans: db.prepare(`SELECT COUNT(*) as c FROM scan_logs WHERE brand_id IN (${scopePh})`).get(...scopeVals).c,
  };
  res.json({ success: true, stats });
});

// ===================== 全局错误处理 =====================

// 404 兜底
app.use((req, res) => {
  res.status(404).json({ success: false, code: 'NOT_FOUND', requestId: req.requestId, msg: '接口不存在' });
});

// 全局错误中间件：任何路由抛出的异常都会到这里，不会让进程崩溃
app.use((err, req, res, next) => {
  console.error(`[${new Date().toLocaleString('zh-CN')}] 接口错误:`, req.requestId, req.method, req.url, err.message);
  if (res.headersSent) return next(err);
  res.status(500).json({ success: false, code: 'INTERNAL_ERROR', requestId: req.requestId, msg: '服务器繁忙，请稍后重试' });
});

function shutdown(reason, exitCode) {
  if (shutdownStarted) return;
  shutdownStarted = true;
  console.error(JSON.stringify({ level: exitCode ? 'error' : 'info', event: 'shutdown', reason, at: new Date().toISOString() }));
  const forceExit = setTimeout(() => process.exit(exitCode), 5000);
  forceExit.unref();
  const finish = () => {
    sessionStore.close();
    try { db.close(); } catch {}
    process.exit(exitCode);
  };
  if (httpServer) httpServer.close(finish);
  else finish();
}

process.once('SIGTERM', () => shutdown('SIGTERM', 0));
process.once('SIGINT', () => shutdown('SIGINT', 0));
process.once('uncaughtException', err => {
  console.error(err);
  shutdown('uncaughtException', 1);
});
process.once('unhandledRejection', reason => {
  console.error(reason);
  shutdown('unhandledRejection', 1);
});

// 启动服务
httpServer = app.listen(PORT, '127.0.0.1', () => {
  console.log(`\n====================================`);
  console.log(`  溯源码系统已启动`);
  console.log(`  管理后台: http://localhost:${PORT}`);
  console.log(`  消费者验证: http://localhost:${PORT}/v/溯源码`);
  console.log(`====================================\n`);
});
