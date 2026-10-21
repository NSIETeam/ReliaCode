const express = require('express');
const session = require('express-session');
const path = require('path');
const fs = require('fs');
const QRCode = require('qrcode');
const ExcelJS = require('exceljs');
const multer = require('multer');
const crypto = require('crypto');
const { db, initDatabase, hashPassword, verifyPassword } = require('./database');

const app = express();
const PORT = process.env.PORT || 3000;

// 初始化数据库
initDatabase();

// 中间件
app.set('trust proxy', 1); // Nginx 反代：从 X-Forwarded-For 取真实访客IP（IP定位/串货检测依赖）
app.disable('x-powered-by');
app.use(express.urlencoded({ extended: true, limit: '256kb' }));
app.use(express.json({ limit: '256kb' }));

// Baseline browser hardening. The current templates still contain inline scripts,
// so CSP keeps inline execution temporarily while forbidding third-party code.
app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy', "default-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; object-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(self), geolocation=(self), microphone=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  next();
});

// ===================== 登录会话 =====================
const SESSION_SECRET = db.prepare("SELECT value FROM settings WHERE key='session_secret'").get()?.value;
if (!SESSION_SECRET || SESSION_SECRET.length < 32) {
  throw new Error('session_secret is missing or too short');
}
app.use(session({
  name: process.env.NODE_ENV === 'production' ? '__Host-reliacode.sid' : 'reliacode.sid',
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: 'auto',
    sameSite: 'lax',
    path: '/',
    maxAge: 12 * 60 * 60 * 1000 // 12小时免登录
  }
}));

// Small in-process login limiter. Nginx remains the outer limiter; this prevents
// accidental exposure through another reverse-proxy path.
const loginAttempts = new Map();
function loginRateLimit(req, res, next) {
  const now = Date.now();
  const key = req.ip || req.socket.remoteAddress || 'unknown';
  const entry = loginAttempts.get(key) || { count: 0, resetAt: now + 5 * 60 * 1000 };
  if (now >= entry.resetAt) {
    entry.count = 0;
    entry.resetAt = now + 5 * 60 * 1000;
  }
  entry.count += 1;
  loginAttempts.set(key, entry);
  if (entry.count > 10) {
    res.setHeader('Retry-After', String(Math.ceil((entry.resetAt - now) / 1000)));
    return res.status(429).render('login', { brand: '溯源码管理系统', error: '登录尝试过多，请稍后再试' });
  }
  next();
}

// 所有视图可用的公共变量：当前用户、未处理预警数
app.use((req, res, next) => {
  res.locals.user = req.session.user || null;
  res.locals.alertsUnread = 0;
  res.locals.brand = '溯源大师';
  res.locals.icon = (name, className = '') => {
    const allowed = new Set(['tag','home','grid','alert','user','box','camera','download','print','trash','lock','clipboard','bell','settings','truck','handshake','location','refresh','check','search','gift','ticket','database','video','cart']);
    const safeName = allowed.has(name) ? name : 'grid';
    const safeClass = String(className).replace(/[^a-zA-Z0-9 _-]/g, '');
    return `<svg class="ui-icon ${safeClass}" aria-hidden="true"><use href="/icons/ui.svg#${safeName}"></use></svg>`;
  };
  if (req.session.user) {
    try {
      const scope = brandScope(req);
      if (scope === null) {
        res.locals.alertsUnread = db.prepare('SELECT COUNT(*) as c FROM alerts WHERE handled=0').get().c;
      } else if (scope) {
        res.locals.alertsUnread = db.prepare('SELECT COUNT(*) as c FROM alerts WHERE handled=0 AND brand_id=?').get(scope).c;
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
  if (req.session.user) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ success: false, msg: '请先登录', needLogin: true });
  return res.redirect('/login');
}
// 角色守卫：requireRole('admin') / requireRole('admin','warehouse')
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.session.user) {
      if (req.path.startsWith('/api/')) return res.status(401).json({ success: false, msg: '请先登录', needLogin: true });
      return res.redirect('/login');
    }
    if (!roles.includes(req.session.user.role)) {
      if (req.path.startsWith('/api/')) return res.status(403).json({ success: false, msg: '没有权限执行此操作' });
      return res.status(403).send('没有权限访问该页面，<a href="/">返回首页</a>');
    }
    next();
  };
}
// 401 时前端跳登录页（供 fetch 全局处理）
const ROLE_NAMES = { admin: '平台管理员', brand: '品牌管理员', factory: '工厂装箱', warehouse: '品牌方', distributor: '代理商' };

// ===================== 品牌数据隔离（SaaS 多租户） =====================
// brandScope(req)：返回 null 表示平台管理员（不限制，看全部品牌）；
// 返回数字表示该账号归属的品牌（所有查询只看该品牌数据）
function brandScope(req) {
  const u = req.session.user;
  if (!u) return undefined;
  if (u.role === 'admin') return null;
  return u.brand_id || null;
}
// 校验某个 brand_id 是否在当前账号的数据范围内
function brandAllowed(scope, brand_id) {
  return scope === null || Number(brand_id) === Number(scope);
}
app.use(express.static(path.join(__dirname, 'public')));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// async 路由包装器：捕获 Promise 拒绝，交给全局错误中间件，避免请求挂死
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ===================== 工具：IP 地理定位（自动反查扫码城市，用于串货检测） =====================

const ipLocCache = new Map(); // IP → 城市（内存缓存，避免重复请求）
async function ipLocate(ip) {
  if (!ip) return '';
  const clean = String(ip).replace(/^::ffff:/, '');
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(clean)) return ''; // 非公网 IPv4 不查
  if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|127\.)/.test(clean)) return '本地网络';
  if (ipLocCache.has(clean)) return ipLocCache.get(clean);
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 4000);
    const r = await fetch(`http://ip-api.com/json/${clean}?lang=zh-CN&fields=status,country,regionName,city`, { signal: ctl.signal });
    clearTimeout(timer);
    const j = await r.json();
    if (j && j.status === 'success') {
      const loc = [j.country, j.regionName, j.city].filter(Boolean).join('');
      ipLocCache.set(clean, loc);
      return loc;
    }
  } catch (e) { /* 查询失败按无定位处理 */ }
  ipLocCache.set(clean, '');
  return '';
}

// ===================== 登录 / 登出 =====================

app.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/');
  const brand = db.prepare("SELECT value FROM settings WHERE key='brand_name'").get()?.value || '溯源码管理系统';
  res.render('login', { brand, error: '' });
});

app.post('/login', loginRateLimit, (req, res, next) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  if (!username || !password) {
    return res.status(401).render('login', { brand: '溯源码管理系统', error: '请输入账号和密码' });
  }
  const user = db.prepare('SELECT * FROM users WHERE username=?').get(username);
  if (!user || !user.enabled || !verifyPassword(password, user.password_hash)) {
    return res.status(401).render('login', { brand: '溯源码管理系统', error: '账号或密码错误' });
  }
  // 代理商账号：绑定代理商信息快照
  let distributor = null;
  if (user.role === 'distributor') {
    distributor = db.prepare('SELECT * FROM distributors WHERE id=?').get(user.distributor_id);
    if (!distributor) return res.status(403).render('login', { brand: '溯源码管理系统', error: '该账号未绑定代理商，请联系管理员' });
  }
  // 工厂账号：绑定工厂信息快照
  let factory = null;
  if (user.role === 'factory') {
    factory = db.prepare('SELECT * FROM factories WHERE id=?').get(user.factory_id);
    if (!factory) return res.status(403).render('login', { brand: '溯源码管理系统', error: '该账号未绑定工厂，请联系管理员' });
  }
  // 品牌信息快照（brand/warehouse/factory/distributor 均按品牌隔离）
  let brandInfo = null;
  if (user.brand_id) {
    brandInfo = db.prepare('SELECT * FROM brands WHERE id=?').get(user.brand_id);
    if (brandInfo && !brandInfo.enabled) {
      return res.status(403).render('login', { brand: '溯源码管理系统', error: '该品牌已被停用，请联系平台管理员' });
    }
  }
  if (user.role === 'brand' && !brandInfo) {
    return res.status(403).render('login', { brand: '溯源码管理系统', error: '该账号未绑定品牌，请联系平台管理员' });
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
  // Rotate the session identifier after authentication to prevent fixation.
  req.session.regenerate((err) => {
    if (err) return next(err);
    req.session.user = sessionUser;
    loginAttempts.delete(req.ip || req.socket.remoteAddress || 'unknown');
    const home = user.role === 'distributor' ? '/portal' : '/';
    res.redirect(home);
  });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ success: true }));
});
app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

// ===================== 邀请码自助注册 =====================

// 注册页（公开，凭邀请码注册工厂/代理商账号）
app.get('/register', (req, res) => {
  if (req.session.user) return res.redirect('/');
  const brand = db.prepare("SELECT value FROM settings WHERE key='brand_name'").get()?.value || '溯源码管理系统';
  res.render('register', { brand, code: String(req.query.code || ''), error: '' });
});

// 邀请码校验（注册页输入邀请码后回显角色）
app.post('/api/register/check-code', (req, res) => {
  const code = String(req.body.code || '').trim().toUpperCase();
  const inv = db.prepare('SELECT * FROM invitations WHERE code=?').get(code);
  if (!inv || inv.status !== 0) return res.json({ success: false, msg: '邀请码无效或已被使用' });
  res.json({ success: true, role: inv.role, note: inv.note });
});

// 凭邀请码注册
app.post('/api/register', (req, res) => {
  const code = String(req.body.code || '').trim().toUpperCase();
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  const company = String(req.body.company || '').trim();
  const region = String(req.body.region || '').trim();
  const contact = String(req.body.contact || '').trim();

  const inv = db.prepare('SELECT * FROM invitations WHERE code=?').get(code);
  if (!inv || inv.status !== 0) return res.json({ success: false, msg: '邀请码无效或已被使用' });
  if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) return res.json({ success: false, msg: '账号需为3-20位字母/数字/下划线' });
  if (password.length < 6) return res.json({ success: false, msg: '密码至少6位' });
  if (!company) return res.json({ success: false, msg: '请填写公司/工厂名称' });
  if (inv.role === 'distributor' && !region) return res.json({ success: false, msg: '请填写负责区域，如：广东省广州市' });
  if (db.prepare('SELECT 1 FROM users WHERE username=?').get(username)) {
    return res.json({ success: false, msg: '该账号已被占用，请换一个' });
  }

  const register = db.transaction(() => {
    if (inv.role === 'factory') {
      // 工厂注册：创建工厂实体并绑定账号（归属邀请码对应品牌）
      const f = db.prepare('INSERT INTO factories (name, contact, brand_id) VALUES (?,?,?)').run(company, contact, inv.brand_id || null);
      db.prepare('INSERT INTO users (username, password_hash, display_name, role, factory_id, brand_id) VALUES (?,?,?,?,?,?)')
        .run(username, hashPassword(password), company, 'factory', f.lastInsertRowid, inv.brand_id || null);
    } else {
      // 代理商注册：创建代理商实体并绑定账号（归属邀请码对应品牌）
      const d = db.prepare('INSERT INTO distributors (name, phone, region, brand_id) VALUES (?,?,?,?)').run(company, contact, region, inv.brand_id || null);
      db.prepare('INSERT INTO users (username, password_hash, display_name, role, distributor_id, brand_id) VALUES (?,?,?,?,?,?)')
        .run(username, hashPassword(password), company, 'distributor', d.lastInsertRowid, inv.brand_id || null);
    }
    db.prepare(`UPDATE invitations SET status=1, used_by=?, used_at=datetime('now','localtime') WHERE id=?`)
      .run(username, inv.id);
  });
  try {
    register();
    res.json({ success: true, msg: '注册成功，请使用新账号登录', username });
  } catch (e) {
    res.json({ success: false, msg: '注册失败：' + e.message });
  }
});

// 邀请码列表（admin/brand；brand 只看自己品牌的邀请码）
app.get('/api/invitations', requireRole('admin', 'brand'), (req, res) => {
  const scope = brandScope(req);
  const invitations = scope === null
    ? db.prepare(`
        SELECT i.id, i.code, i.role, i.note, i.status, i.used_by, i.used_at, i.created_at, b.name as brand_name
        FROM invitations i LEFT JOIN brands b ON i.brand_id=b.id
        ORDER BY i.id DESC LIMIT 200
      `).all()
    : db.prepare(`
        SELECT i.id, i.code, i.role, i.note, i.status, i.used_by, i.used_at, i.created_at, b.name as brand_name
        FROM invitations i LEFT JOIN brands b ON i.brand_id=b.id
        WHERE i.brand_id=? ORDER BY i.id DESC LIMIT 200
      `).all(scope);
  res.json({ success: true, invitations });
});

// 生成邀请码（admin 可指定品牌；brand 只能生成自己品牌的工厂/代理商邀请码）
app.post('/api/invitations', requireRole('admin', 'brand'), (req, res) => {
  const role = req.body.role;
  const note = String(req.body.note || '').trim();
  const scope = brandScope(req);
  if (!['factory', 'distributor'].includes(role)) return res.json({ success: false, msg: '角色不合法' });
  let brand_id = scope !== null ? scope : (parseInt(req.body.brand_id) || null);
  if (brand_id && !db.prepare('SELECT 1 FROM brands WHERE id=? AND enabled=1').get(brand_id)) {
    return res.json({ success: false, msg: '所选品牌不存在或已停用' });
  }
  let code;
  do {
    code = 'INV' + Math.random().toString(36).substring(2, 10).toUpperCase();
  } while (db.prepare('SELECT 1 FROM invitations WHERE code=?').get(code));
  db.prepare('INSERT INTO invitations (code, role, note, brand_id) VALUES (?,?,?,?)').run(code, role, note, brand_id);
  logOperation(req, 'create_invitation', 'invitation', code, `生成${role === 'factory' ? '工厂' : '代理商'}邀请码「${code}」${brand_id ? '（品牌：' + (db.prepare('SELECT name FROM brands WHERE id=?').get(brand_id)?.name || '') + '）' : ''}`);
  res.json({ success: true, code, msg: '邀请码已生成' });
});

// 作废/删除邀请码（admin/brand；brand 只能操作自己品牌的邀请码）
app.delete('/api/invitations/:id', requireRole('admin', 'brand'), (req, res) => {
  const inv = db.prepare('SELECT * FROM invitations WHERE id=?').get(req.params.id);
  if (!inv) return res.json({ success: false, msg: '邀请码不存在' });
  if (!brandAllowed(brandScope(req), inv.brand_id)) return res.json({ success: false, msg: '没有权限操作该邀请码' });
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

// 品牌列表（含各品牌数据量统计）
app.get('/api/brands', requireRole('admin'), (req, res) => {
  const brands = db.prepare(`
    SELECT b.*,
      (SELECT COUNT(*) FROM products p WHERE p.brand_id=b.id) as product_count,
      (SELECT COUNT(*) FROM factories f WHERE f.brand_id=b.id) as factory_count,
      (SELECT COUNT(*) FROM distributors d WHERE d.brand_id=b.id) as distributor_count,
      (SELECT COUNT(*) FROM users u WHERE u.brand_id=b.id) as user_count
    FROM brands b ORDER BY b.id
  `).all();
  res.json({ success: true, brands });
});

// 新建品牌
app.post('/api/brands', requireRole('admin'), (req, res) => {
  const name = String(req.body.name || '').trim();
  const contact = String(req.body.contact || '').trim();
  if (!name) return res.json({ success: false, msg: '品牌名称不能为空' });
  if (db.prepare('SELECT 1 FROM brands WHERE name=?').get(name)) return res.json({ success: false, msg: '品牌名称已存在' });
  const r = db.prepare('INSERT INTO brands (name, contact) VALUES (?,?)').run(name, contact);
  logOperation(req, 'create_brand', 'brand', r.lastInsertRowid, `品牌「${name}」已创建`);
  res.json({ success: true, id: r.lastInsertRowid, msg: '品牌已创建' });
});

// 修改品牌（改名/联系人/启停）
app.put('/api/brands/:id', requireRole('admin'), (req, res) => {
  const b = db.prepare('SELECT * FROM brands WHERE id=?').get(req.params.id);
  if (!b) return res.json({ success: false, msg: '品牌不存在' });
  const { name, contact, enabled } = req.body;
  if (name !== undefined && String(name).trim()) db.prepare('UPDATE brands SET name=? WHERE id=?').run(String(name).trim(), b.id);
  if (contact !== undefined) db.prepare('UPDATE brands SET contact=? WHERE id=?').run(String(contact).trim(), b.id);
  if (enabled !== undefined) {
    db.prepare('UPDATE brands SET enabled=? WHERE id=?').run(enabled ? 1 : 0, b.id);
    logOperation(req, 'toggle_brand', 'brand', b.id, `品牌「${b.name}」已${enabled ? '启用' : '停用'}`);
  }
  res.json({ success: true, msg: '品牌已更新' });
});

// ===================== 页面路由 =====================

// 管理后台首页（按角色分流：工厂→装箱页，仓库→发货页，代理商→自助端；品牌管理员→品牌版首页）
app.get('/', requireLogin, (req, res) => {
  const role = req.session.user.role;
  if (role === 'factory') return res.redirect('/factory');
  if (role === 'warehouse') return res.redirect('/warehouse');
  if (role === 'distributor') return res.redirect('/portal');
  // admin 看全局，brand 只看自己品牌
  const scope = brandScope(req);
  const bp = scope === null ? '' : ' AND p.brand_id=?';
  const bcond = scope === null ? '' : ' AND b.brand_id=?';
  const bparam = scope === null ? [] : [scope];
  const pparam = scope === null ? [] : [scope];
  const p2param = scope === null ? [] : [scope];
  const stats = {
    products: db.prepare(`SELECT COUNT(*) as c FROM products p WHERE 1=1 ${bp}`).get(...pparam).c,
    boxes: db.prepare(`SELECT COUNT(*) as c FROM boxes b JOIN products p ON b.product_id=p.id WHERE 1=1 ${bp}`).get(...pparam).c,
    items: db.prepare(`SELECT COUNT(*) as c FROM items i JOIN products p ON i.product_id=p.id WHERE 1=1 ${bp}`).get(...pparam).c,
    distributors: db.prepare(`SELECT COUNT(*) as c FROM distributors WHERE 1=1 ${scope === null ? '' : ' AND brand_id=?'}`).get(...bparam).c,
    shipped: db.prepare(`SELECT COUNT(*) as c FROM boxes b JOIN products p ON b.product_id=p.id WHERE b.status='shipped' ${bp}`).get(...pparam).c,
    scanned: db.prepare(`SELECT COUNT(*) as c FROM items i JOIN products p ON i.product_id=p.id WHERE i.status='scanned' ${bp}`).get(...pparam).c,
    diversions: db.prepare(`SELECT COUNT(*) as c FROM scan_logs WHERE is_diversion>0 ${scope === null ? '' : ' AND brand_id=?'}`).get(...bparam).c,
  };
  const recentScans = scope === null
    ? db.prepare('SELECT * FROM scan_logs ORDER BY scanned_at DESC LIMIT 10').all()
    : db.prepare('SELECT * FROM scan_logs WHERE brand_id=? ORDER BY scanned_at DESC LIMIT 10').all(scope);
  // 仓库手机入口 + 工厂手机入口（工人手机扫码直接打开）
  const baseUrl = getBaseUrl(req);
  const entryUrl = `${baseUrl}/warehouse`;
  const factoryUrl = `${baseUrl}/factory`;
  res.render('admin', { stats, recentScans, entryUrl, factoryUrl });
});

// 业务导航页（admin/brand 专用 - 移动端底部「业务」Tab 入口）
app.get('/admin/business', requireRole('admin', 'brand'), (req, res) => {
  res.render('admin-business');
});

// 我的导航页（admin/brand 专用 - 移动端底部「我的」Tab 入口）
app.get('/admin/me', requireRole('admin', 'brand'), (req, res) => {
  res.render('admin-me');
});

// 码生成页面（brand 只看自己品牌的产品和工厂）
app.get('/generate', requireRole('admin', 'brand'), (req, res) => {
  const scope = brandScope(req);
  const products = scope === null
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
        WHERE p.brand_id = ?
        ORDER BY p.id DESC
      `).all(scope);
  const factories = scope === null
    ? db.prepare('SELECT id, name FROM factories ORDER BY id DESC').all()
    : db.prepare('SELECT id, name FROM factories WHERE brand_id=? ORDER BY id DESC').all(scope);
  const brands = scope === null
    ? db.prepare('SELECT id, name FROM brands WHERE enabled=1 ORDER BY id').all()
    : [];
  res.render('generate', { products, factories, brands });
});

// 仓库发货扫码页面（brand 发货时只能选自己品牌的代理商）
app.get('/warehouse', requireRole('admin', 'warehouse', 'brand'), (req, res) => {
  const scope = brandScope(req);
  const distributors = scope === null
    ? db.prepare('SELECT * FROM distributors ORDER BY id DESC').all()
    : db.prepare('SELECT * FROM distributors WHERE brand_id=? ORDER BY id DESC').all(scope);
  res.render('warehouse', { distributors });
});

// 工厂装箱扫码页面（数据隔离：工厂只见自己工厂的产品；品牌管理员见本品牌全部产品）
app.get('/factory', requireRole('admin', 'factory', 'brand'), (req, res) => {
  let sql = 'SELECT * FROM products WHERE 1=1';
  const params = [];
  const role = req.session.user.role;
  if (role === 'factory' && req.session.user.factory_id) {
    sql += ' AND factory_id=?';
    params.push(req.session.user.factory_id);
  } else if (role === 'brand' && req.session.user.brand_id) {
    sql += ' AND brand_id=?';
    params.push(req.session.user.brand_id);
  }
  sql += ' ORDER BY id DESC';
  const products = db.prepare(sql).all(...params);
  res.render('factory', { products });
});

// 代理商管理页面（brand 只看自己品牌；admin 建代理商时可选归属品牌）
app.get('/distributors', requireRole('admin', 'brand'), (req, res) => {
  const scope = brandScope(req);
  const distributors = scope === null
    ? db.prepare('SELECT d.*, b.name as brand_name FROM distributors d LEFT JOIN brands b ON d.brand_id=b.id ORDER BY d.id DESC').all()
    : db.prepare('SELECT d.*, b.name as brand_name FROM distributors d LEFT JOIN brands b ON d.brand_id=b.id WHERE d.brand_id=? ORDER BY d.id DESC').all(scope);
  const brands = scope === null
    ? db.prepare('SELECT id, name FROM brands WHERE enabled=1 ORDER BY id').all()
    : [];
  res.render('distributors', { distributors, brands });
});

// 扫码日志页面（brand 只看自己品牌）
app.get('/logs', requireRole('admin', 'brand'), (req, res) => {
  const scope = brandScope(req);
  const logs = scope === null
    ? db.prepare('SELECT * FROM scan_logs ORDER BY scanned_at DESC LIMIT 200').all()
    : db.prepare('SELECT * FROM scan_logs WHERE brand_id=? ORDER BY scanned_at DESC LIMIT 200').all(scope);
  res.render('logs', { logs });
});

// 删除单条扫码日志（admin/brand；brand 只能删自己品牌的）
app.delete('/api/scan-logs/:id', requireRole('admin', 'brand'), (req, res) => {
  const log = db.prepare('SELECT * FROM scan_logs WHERE id=?').get(req.params.id);
  if (!log) return res.json({ success: false, msg: '记录不存在或已删除' });
  if (!brandAllowed(brandScope(req), log.brand_id)) return res.json({ success: false, msg: '没有权限删除该记录' });
  db.prepare('DELETE FROM scan_logs WHERE id=?').run(log.id);
  logOperation(req, 'delete_scan_log', 'scan_log', log.item_code, `删除扫码记录：${log.item_code}（${log.scan_location || '位置未知'}）`);
  res.json({ success: true, msg: '已删除' });
});

// 批量删除扫码日志（ids 数组；brand 只能删自己品牌的）
app.post('/api/scan-logs/batch-delete', requireRole('admin', 'brand'), (req, res) => {
  const scope = brandScope(req);
  const ids = Array.isArray(req.body.ids) ? req.body.ids.map(Number).filter(Number.isInteger) : [];
  if (!ids.length) return res.json({ success: false, msg: '请先勾选要删除的记录' });
  const del = db.transaction(() => {
    let n = 0;
    for (const id of ids) {
      const log = db.prepare('SELECT id, brand_id FROM scan_logs WHERE id=?').get(id);
      if (!log || !brandAllowed(scope, log.brand_id)) continue;
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
  const settings = Object.fromEntries(db.prepare('SELECT key, value FROM settings').all().map(r => [r.key, r.value]));
  const campaigns = db.prepare('SELECT * FROM campaigns ORDER BY id DESC').all();
  const prizes = db.prepare(`
    SELECT p.*, c.name as campaign_name
    FROM prize_records p LEFT JOIN campaigns c ON p.campaign_id = c.id
    ORDER BY p.id DESC LIMIT 50
  `).all();
  res.render('settings', { settings, campaigns, prizes });
});

// 标签打印页面
app.get('/print', requireRole('admin', 'brand'), (req, res) => {
  const codes = (req.query.codes || '').split(',').map(s => s.trim()).filter(Boolean);
  const type = req.query.type || 'item';
  const product = req.query.product || '';
  const brand = db.prepare("SELECT value FROM settings WHERE key='brand_name'").get()?.value || '';
  res.render('print', { codes, type, product, brand });
});

// 码查询页面
app.get('/codes', requireRole('admin', 'brand'), (req, res) => {
  res.render('codes');
});

// 消费者验证页面（H5，嵌入公众号）：/v 为无码入口（手动输码/摄像头扫码），/v/:code 为二维码直达
app.get(['/v', '/v/:code'], (req, res) => {
  const code = req.params.code || '';
  const settings = Object.fromEntries(db.prepare('SELECT key, value FROM settings').all().map(r => [r.key, r.value]));
  const brandStats = {
    total_scans: db.prepare('SELECT COUNT(*) as c FROM scan_logs').get().c,
    verified_items: db.prepare("SELECT COUNT(*) as c FROM items WHERE status='scanned'").get().c
  };
  res.render('verify', { code, settings, brandStats });
});

// ===================== API 路由 =====================

// API 全局登录守卫：除消费者验证、动态二维码外，所有 /api 接口均需登录
app.use('/api', (req, res, next) => {
  const open = req.path === '/qr' || req.path.startsWith('/verify/') || req.path === '/login' || req.path === '/logout';
  if (open || req.session.user) return next();
  return res.status(401).json({ success: false, msg: '登录已过期，请重新登录', needLogin: true });
});

// --- 产品管理 ---

// 新增产品（admin 可指定工厂；brand 只能建自己品牌的产品，可选工厂限本品牌）
app.post('/api/products', requireRole('admin', 'brand'), (req, res) => {
  const { name, spec, batch_no } = req.body;
  const box_size = parseInt(req.body.box_size) || 0;
  const scope = brandScope(req);
  let factory_id = parseInt(req.body.factory_id) || null;
  let brand_id = null;
  if (!name) return res.json({ success: false, msg: '产品名称不能为空' });
  if (factory_id) {
    const factory = db.prepare('SELECT * FROM factories WHERE id=?').get(factory_id);
    if (!factory) return res.json({ success: false, msg: '所选工厂不存在' });
    if (!brandAllowed(scope, factory.brand_id)) return res.json({ success: false, msg: '所选工厂不属于你的品牌' });
    brand_id = factory.brand_id;
  }
  if (scope !== null) brand_id = scope;
  // 平台管理员可显式指定品牌（未指定工厂时生效）
  if (scope === null && !factory_id && req.body.brand_id) brand_id = parseInt(req.body.brand_id) || null;
  const result = db.prepare('INSERT INTO products (name, spec, batch_no, box_size, factory_id, brand_id) VALUES (?,?,?,?,?,?)')
    .run(name, spec || '', batch_no || '', box_size, factory_id, brand_id);
  res.json({ success: true, id: result.lastInsertRowid });
});

// 修改产品（含箱规）
app.put('/api/products/:id', requireRole('admin', 'brand'), (req, res) => {
  const { id } = req.params;
  const { name, spec, batch_no } = req.body;
  const box_size = parseInt(req.body.box_size) || 0;
  if (!name) return res.json({ success: false, msg: '产品名称不能为空' });
  const product = db.prepare('SELECT * FROM products WHERE id=?').get(id);
  if (!product) return res.json({ success: false, msg: '产品不存在' });
  if (!brandAllowed(brandScope(req), product.brand_id)) return res.json({ success: false, msg: '没有权限操作该产品' });
  db.prepare('UPDATE products SET name=?, spec=?, batch_no=?, box_size=? WHERE id=?').run(name, spec || '', batch_no || '', box_size, id);
  res.json({ success: true });
});

// 删除产品（admin/brand；该产品下没有任何未删除的箱码/子码时才能删除）
app.delete('/api/products/:id', requireRole('admin', 'brand'), (req, res) => {
  const { id } = req.params;
  const pid = parseInt(id);
  if (!pid) return res.json({ success: false, msg: '无效的产品 ID' });
  const product = db.prepare('SELECT * FROM products WHERE id=?').get(pid);
  if (!product) return res.json({ success: false, msg: '产品不存在' });
  if (!brandAllowed(brandScope(req), product.brand_id)) return res.json({ success: false, msg: '没有权限操作该产品' });
  const boxCount = db.prepare("SELECT COUNT(*) c FROM boxes WHERE product_id=?").get(pid).c;
  if (boxCount > 0) return res.json({ success: false, msg: '该产品下还有 ' + boxCount + ' 个箱码，请先删除/作废所有码' });
  const itemCount = db.prepare("SELECT COUNT(*) c FROM items WHERE product_id=?").get(pid).c;
  if (itemCount > 0) return res.json({ success: false, msg: '该产品下还有 ' + itemCount + ' 个子码，请先删除/作废所有码' });
  db.prepare('DELETE FROM products WHERE id=?').run(pid);
  logOperation(req, 'delete_product', 'product', pid, '产品「' + product.name + '」已物理删除');
  res.json({ success: true, msg: '产品已删除' });
});

// 获取产品列表（工厂角色只看自己工厂；品牌管理员只看自己品牌）
app.get('/api/products', requireRole('admin', 'factory', 'brand'), (req, res) => {
  let sql = 'SELECT * FROM products WHERE 1=1';
  const params = [];
  const role = req.session.user.role;
  if (role === 'factory' && req.session.user.factory_id) {
    sql += ' AND factory_id=?';
    params.push(req.session.user.factory_id);
  } else if (role === 'brand' && req.session.user.brand_id) {
    sql += ' AND brand_id=?';
    params.push(req.session.user.brand_id);
  }
  sql += ' ORDER BY id DESC';
  const products = db.prepare(sql).all(...params);
  res.json({ success: true, products });
});

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

// 二维码内容跟随访问地址动态生成（本地 localhost / 局域网 IP / 线上域名均可）
const getBaseUrl = (req) => `${req.protocol}://${req.get('host')}`;

// 单独生成箱码（父码，暂不绑定子码）
// product_id 可选：不选产品=空白箱码，装箱时扫箱码再选择产品；选了产品则码自带产品信息
app.post('/api/codes/generate/boxes', requireRole('admin', 'brand'), wrap(async (req, res) => {
  const { product_id, batch_no, box_count } = req.body;
  const bCount = Math.min(parseInt(box_count) || 1, 1000);
  const scope = brandScope(req);

  let pid = null, brandId = null;
  if (product_id) {
    const product = db.prepare('SELECT * FROM products WHERE id=?').get(product_id);
    if (!product) return res.json({ success: false, msg: '产品不存在' });
    if (!brandAllowed(scope, product.brand_id)) return res.json({ success: false, msg: '该产品不属于你的品牌' });
    pid = product.id;
    brandId = product.brand_id;
  } else {
    // 空白箱码：品牌归属=当前账号品牌（平台管理员可显式指定，默认平台级）
    brandId = scope !== null ? scope : (parseInt(req.body.brand_id) || null);
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
    const boxResult = insertBox.run(boxCode, pid, brandId, batch_no || '');
    const boxUrl = `${baseUrl}/v/${boxCode}`;
    const boxQrPath = path.join(__dirname, 'public', 'qr', `${boxCode}.png`);
    await QRCode.toFile(boxQrPath, boxUrl, { width: 300, margin: 1 });
    generated.push({ id: Number(boxResult.lastInsertRowid), box_code: boxCode, qr_url: `/qr/${boxCode}.png` });
  }

  res.json({ success: true, generated, count: generated.length });
}));

// 单独生成子码（未绑定箱码）
// product_id 可选：不选产品=空白子码，装箱绑定箱码时自动跟随箱码产品
app.post('/api/codes/generate/items', requireRole('admin', 'brand'), wrap(async (req, res) => {
  const { product_id, batch_no, item_count } = req.body;
  const iCount = Math.min(parseInt(item_count) || 1, 5000);
  const scope = brandScope(req);

  let pid = null, brandId = null;
  if (product_id) {
    const product = db.prepare('SELECT * FROM products WHERE id=?').get(product_id);
    if (!product) return res.json({ success: false, msg: '产品不存在' });
    if (!brandAllowed(scope, product.brand_id)) return res.json({ success: false, msg: '该产品不属于你的品牌' });
    pid = product.id;
    brandId = product.brand_id;
  } else {
    brandId = scope !== null ? scope : (parseInt(req.body.brand_id) || null);
  }

  const insertItem = db.prepare('INSERT INTO items (item_code, box_id, product_id, brand_id, batch_no) VALUES (?,NULL,?,?,?)');
  const generated = [];
  const baseUrl = getBaseUrl(req);

  for (let i = 0; i < iCount; i++) {
    let itemCode = genCode('S');
    while (db.prepare('SELECT 1 FROM items WHERE item_code=?').get(itemCode)) {
      itemCode = genCode('S');
    }
    const itemResult = insertItem.run(itemCode, pid, brandId, batch_no || '');
    const itemUrl = `${baseUrl}/v/${itemCode}`;
    const itemQrPath = path.join(__dirname, 'public', 'qr', `${itemCode}.png`);
    await QRCode.toFile(itemQrPath, itemUrl, { width: 200, margin: 1 });
    generated.push({ id: Number(itemResult.lastInsertRowid), item_code: itemCode, qr_url: `/qr/${itemCode}.png` });
  }

  res.json({ success: true, generated, count: generated.length });
}));

// 获取未绑定箱码的子码（用于绑定界面；brand 只看自己品牌；空白码用自身 brand_id 隔离）
app.get('/api/codes/unbound', requireRole('admin', 'brand'), (req, res) => {
  const scope = brandScope(req);
  const cond = scope === null ? '' : ' AND COALESCE(i.brand_id, p.brand_id)=?';
  const params = scope === null ? [] : [scope];
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
app.get('/api/codes/box/:code', requireRole('admin', 'brand'), (req, res) => {
  const code = extractCode(req.params.code);
  const box = db.prepare(`
    SELECT b.*, p.name as product_name, COALESCE(b.brand_id, p.brand_id) as eff_brand_id
    FROM boxes b LEFT JOIN products p ON b.product_id = p.id
    WHERE b.box_code = ?
  `).get(code);
  if (!box) return res.json({ success: false, msg: '箱码不存在' });
  if (!brandAllowed(brandScope(req), box.eff_brand_id)) return res.json({ success: false, msg: '没有权限查看该箱码' });

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
app.post('/api/codes/bind', requireRole('admin', 'brand'), (req, res) => {
  const { item_codes } = req.body;
  const box_code = extractCode(req.body.box_code);
  const scope = brandScope(req);
  if (!box_code) return res.json({ success: false, msg: '请输入箱码' });
  if (!item_codes || item_codes.length === 0) return res.json({ success: false, msg: '请选择要绑定的子码' });

  const box = db.prepare(`
    SELECT b.*, COALESCE(b.brand_id, p.brand_id) as eff_brand_id FROM boxes b LEFT JOIN products p ON b.product_id=p.id WHERE b.box_code=?
  `).get(box_code);
  if (!box) return res.json({ success: false, msg: '箱码不存在' });
  if (!brandAllowed(scope, box.eff_brand_id)) return res.json({ success: false, msg: '该箱码不属于你的品牌' });
  if (box.status === 'shipped') return res.json({ success: false, msg: '该箱已发货，不能继续绑定' });

  const tx = db.transaction(() => {
    for (const code of item_codes) {
      const item = db.prepare('SELECT * FROM items WHERE item_code=?').get(code);
      if (!item) continue;
      if (item.box_id) continue; // 已绑定的跳过
      if (item.status === 'shipped') continue;
      // 箱码有产品则子码跟随箱码产品；箱码为空白码时保留子码自身产品
      db.prepare('UPDATE items SET box_id=?, product_id=COALESCE(?, product_id), brand_id=COALESCE(?, brand_id) WHERE id=?')
        .run(box.id, box.product_id, box.eff_brand_id, item.id);
    }
    const count = db.prepare('SELECT COUNT(*) as c FROM items WHERE box_id=?').get(box.id).c;
    db.prepare('UPDATE boxes SET item_count=? WHERE id=?').run(count, box.id);
  });
  tx();

  const count = db.prepare('SELECT COUNT(*) as c FROM items WHERE box_id=?').get(box.id).c;
  res.json({ success: true, msg: `绑定成功，该箱现有 ${count} 个子码`, count });
});

// 解绑子码（从箱码中移出；brand 只能操作自己品牌）
app.post('/api/codes/unbind', requireRole('admin', 'brand'), (req, res) => {
  const item_code = extractCode(req.body.item_code);
  if (!item_code) return res.json({ success: false, msg: '请输入子码' });

  const item = db.prepare(`
    SELECT i.*, COALESCE(i.brand_id, p.brand_id) as eff_brand_id FROM items i LEFT JOIN products p ON i.product_id=p.id WHERE i.item_code=?
  `).get(item_code);
  if (!item) return res.json({ success: false, msg: '子码不存在' });
  if (!brandAllowed(brandScope(req), item.eff_brand_id)) return res.json({ success: false, msg: '该子码不属于你的品牌' });
  if (!item.box_id) return res.json({ success: false, msg: '该子码未绑定任何箱码' });
  if (item.status === 'shipped' || item.status === 'scanned') {
    return res.json({ success: false, msg: '该子码已发货/已扫码，不能解绑' });
  }

  const boxId = item.box_id;
  const tx = db.transaction(() => {
    db.prepare('UPDATE items SET box_id=NULL WHERE id=?').run(item.id);
    const count = db.prepare('SELECT COUNT(*) as c FROM items WHERE box_id=?').get(boxId).c;
    db.prepare('UPDATE boxes SET item_count=? WHERE id=?').run(count, boxId);
  });
  tx();

  res.json({ success: true, msg: '解绑成功' });
});

// 获取码列表（brand 只看自己品牌的码）
app.get('/api/codes', requireRole('admin', 'brand'), (req, res) => {
  const { type, page, keyword, status } = req.query;
  const all = req.query.all === '1';   // 全量模式（批量打印用，上限5000条）
  const pageNum = all ? 1 : (parseInt(page) || 1);
  const pageSize = all ? 5000 : 20;
  const offset = (pageNum - 1) * pageSize;
  const scope = brandScope(req);

  if (type === 'box') {
    const conds = [];
    const params = [];
    if (scope !== null) { conds.push('COALESCE(b.brand_id, p.brand_id)=?'); params.push(scope); }
    if (keyword) { conds.push('(b.box_code LIKE ? OR p.name LIKE ?)'); params.push(`%${keyword}%`, `%${keyword}%`); }
    if (status === 'shipped') conds.push("b.status = 'shipped'");
    else if (status === 'in_stock') conds.push("b.status = 'in_stock'");
    else if (status === 'invalid') conds.push("b.status = 'invalid'");
    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
    const total = db.prepare(`SELECT COUNT(*) as c FROM boxes b LEFT JOIN products p ON b.product_id=p.id ${where}`).get(...params).c;
    const boxes = db.prepare(`
      SELECT b.*, p.name as product_name, br.name as brand_name,
        (SELECT COUNT(*) FROM items i WHERE i.box_id=b.id AND i.status='scanned') as scanned_count
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
    if (scope !== null) { conds.push('COALESCE(i.brand_id, p.brand_id)=?'); params.push(scope); }
    if (keyword) { conds.push('(i.item_code LIKE ? OR p.name LIKE ?)'); params.push(`%${keyword}%`, `%${keyword}%`); }
    if (status === 'scanned') conds.push("i.status = 'scanned'");
    else if (status === 'shipped') conds.push("i.status = 'shipped'");
    else if (status === 'in_stock') conds.push("i.status = 'in_stock'");
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
    const u = req.session.user || {};
    db.prepare(`INSERT INTO operation_logs (user_id, username, role, action, target_type, target_id, detail, ip, brand_id)
      VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(u.id || null, u.username || null, u.role || null, action, targetType || null, String(targetId || ''), detail || null, req.ip || null, u.brand_id || null);
  } catch (e) { console.error('[logOperation]', e.message); }
}

// 删除码（admin/brand；未发货/未扫码的码可物理删除）
app.delete('/api/codes/:type/:id', requireRole('admin', 'brand'), (req, res) => {
  const { type, id } = req.params;
  const codeId = parseInt(id);
  const scope = brandScope(req);
  if (!codeId) return res.json({ success: false, msg: '无效的 ID' });
  if (type === 'box') {
    const box = db.prepare(`
      SELECT b.*, COALESCE(b.brand_id, p.brand_id) as brand_id FROM boxes b LEFT JOIN products p ON b.product_id=p.id WHERE b.id=?
    `).get(codeId);
    if (!box) return res.json({ success: false, msg: '箱码不存在' });
    if (!brandAllowed(scope, box.brand_id)) return res.json({ success: false, msg: '没有权限操作该箱码' });
    if (box.status === 'shipped') return res.json({ success: false, msg: '已发货的箱码不能删除（如需作废请用「标记作废」）' });
    const childCount = db.prepare('SELECT COUNT(*) c FROM items WHERE box_id=?').get(codeId).c;
    if (childCount > 0) return res.json({ success: false, msg: `该箱下还有 ${childCount} 个子码，请先删除子码` });
    db.prepare('DELETE FROM boxes WHERE id=?').run(codeId);
    logOperation(req, 'delete_box', 'box', box.box_code, `箱码「${box.box_code}」已物理删除`);
    return res.json({ success: true, msg: '箱码已删除' });
  } else if (type === 'item') {
    const item = db.prepare(`
      SELECT i.*, COALESCE(i.brand_id, p.brand_id) as brand_id FROM items i LEFT JOIN products p ON i.product_id=p.id WHERE i.id=?
    `).get(codeId);
    if (!item) return res.json({ success: false, msg: '子码不存在' });
    if (!brandAllowed(scope, item.brand_id)) return res.json({ success: false, msg: '没有权限操作该子码' });
    if (item.status === 'shipped') return res.json({ success: false, msg: '已发货的子码不能删除' });
    if (item.status === 'scanned') return res.json({ success: false, msg: '已扫码的子码不能删除（溯源数据需要保留）' });
    db.prepare('DELETE FROM items WHERE id=?').run(codeId);
    logOperation(req, 'delete_item', 'item', item.item_code, `子码「${item.item_code}」已物理删除`);
    return res.json({ success: true, msg: '子码已删除' });
  }
  return res.json({ success: false, msg: '不支持的码类型' });
});

// 批量删除码（admin/brand；只删可物理删除的码，其余跳过并返回原因）
app.post('/api/codes/batch-delete', requireRole('admin', 'brand'), (req, res) => {
  const { type, ids } = req.body || {};
  const scope = brandScope(req);
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
        if (!brandAllowed(scope, box.brand_id)) { skipped.push({ code: box.box_code, msg: '无权限' }); continue; }
        if (box.status === 'shipped') { skipped.push({ code: box.box_code, msg: '已发货' }); continue; }
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
        if (!brandAllowed(scope, item.brand_id)) { skipped.push({ code: item.item_code, msg: '无权限' }); continue; }
        if (item.status === 'shipped') { skipped.push({ code: item.item_code, msg: '已发货' }); continue; }
        if (item.status === 'scanned') { skipped.push({ code: item.item_code, msg: '已扫码' }); continue; }
        db.prepare('DELETE FROM items WHERE id=?').run(codeId);
        logOperation(req, 'delete_item', 'item', item.item_code, `子码「${item.item_code}」批量删除`);
        deleted.push(item.item_code);
      }
    }
  });
  run();

  let msg = `已删除 ${deleted.length} 个${type === 'box' ? '箱码' : '子码'}`;
  if (skipped.length) msg += `，跳过 ${skipped.length} 个（已发货/已扫码/箱下有子码的不可删除）`;
  res.json({ success: true, deleted: deleted.length, skipped, msg });
});

// 标记作废（admin/brand；任何状态的码都可作废，作废后视为失效，仍保留溯源记录）
app.patch('/api/codes/:type/:id/invalidate', requireRole('admin', 'brand'), (req, res) => {
  const { type, id } = req.params;
  const codeId = parseInt(id);
  const scope = brandScope(req);
  if (!codeId) return res.json({ success: false, msg: '无效的 ID' });
  const { reason } = req.body || {};
  if (type === 'box') {
    const box = db.prepare(`
      SELECT b.*, COALESCE(b.brand_id, p.brand_id) as brand_id FROM boxes b LEFT JOIN products p ON b.product_id=p.id WHERE b.id=?
    `).get(codeId);
    if (!box) return res.json({ success: false, msg: '箱码不存在' });
    if (!brandAllowed(scope, box.brand_id)) return res.json({ success: false, msg: '没有权限操作该箱码' });
    if (box.status === 'invalid') return res.json({ success: false, msg: '该箱已是作废状态' });
    db.prepare("UPDATE boxes SET status='invalid' WHERE id=?").run(codeId);
    logOperation(req, 'invalidate_box', 'box', box.box_code, `箱码「${box.box_code}」已标记作废${reason ? '，原因：' + reason : ''}`);
    return res.json({ success: true, msg: '箱码已标记作废' });
  } else if (type === 'item') {
    const item = db.prepare(`
      SELECT i.*, COALESCE(i.brand_id, p.brand_id) as brand_id FROM items i LEFT JOIN products p ON i.product_id=p.id WHERE i.id=?
    `).get(codeId);
    if (!item) return res.json({ success: false, msg: '子码不存在' });
    if (!brandAllowed(scope, item.brand_id)) return res.json({ success: false, msg: '没有权限操作该子码' });
    if (item.status === 'invalid') return res.json({ success: false, msg: '该子码已是作废状态' });
    db.prepare("UPDATE items SET status='invalid' WHERE id=?").run(codeId);
    logOperation(req, 'invalidate_item', 'item', item.item_code, `子码「${item.item_code}」已标记作废${reason ? '，原因：' + reason : ''}`);
    return res.json({ success: true, msg: '子码已标记作废' });
  }
  return res.json({ success: false, msg: '不支持的码类型' });
});

// 操作日志查询接口（brand 只看自己品牌的操作）
app.get('/api/operation_logs', requireRole('admin', 'brand'), (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 100, 500);
  const scope = brandScope(req);
  const rows = scope === null
    ? db.prepare('SELECT * FROM operation_logs ORDER BY id DESC LIMIT ?').all(limit)
    : db.prepare('SELECT * FROM operation_logs WHERE brand_id=? ORDER BY id DESC LIMIT ?').all(scope, limit);
  res.json({ success: true, logs: rows });
});

// --- 代理商管理（brand 只能管理自己品牌的代理商） ---

// 新增代理商
app.post('/api/distributors', requireRole('admin', 'brand'), (req, res) => {
  const { name, phone, region, address } = req.body;
  const scope = brandScope(req);
  if (!name) return res.json({ success: false, msg: '代理商名称不能为空' });
  let brand_id = scope !== null ? scope : (parseInt(req.body.brand_id) || null);
  if (brand_id && !db.prepare('SELECT 1 FROM brands WHERE id=? AND enabled=1').get(brand_id)) {
    return res.json({ success: false, msg: '所选品牌不存在或已停用' });
  }
  const result = db.prepare('INSERT INTO distributors (name, phone, region, address, brand_id) VALUES (?,?,?,?,?)')
    .run(name, phone || '', region || '', address || '', brand_id);
  res.json({ success: true, id: result.lastInsertRowid });
});

// 删除代理商（brand 只能删自己品牌的）
app.delete('/api/distributors/:id', requireRole('admin', 'brand'), (req, res) => {
  const { id } = req.params;
  const d = db.prepare('SELECT * FROM distributors WHERE id=?').get(id);
  if (!d) return res.json({ success: false, msg: '代理商不存在' });
  if (!brandAllowed(brandScope(req), d.brand_id)) return res.json({ success: false, msg: '没有权限操作该代理商' });
  db.prepare('DELETE FROM distributors WHERE id=?').run(id);
  res.json({ success: true });
});

// 更新代理商（brand 只能改自己品牌的）
app.put('/api/distributors/:id', requireRole('admin', 'brand'), (req, res) => {
  const { id } = req.params;
  const d = db.prepare('SELECT * FROM distributors WHERE id=?').get(id);
  if (!d) return res.json({ success: false, msg: '代理商不存在' });
  if (!brandAllowed(brandScope(req), d.brand_id)) return res.json({ success: false, msg: '没有权限操作该代理商' });
  const { name, phone, region, address } = req.body;
  db.prepare('UPDATE distributors SET name=?, phone=?, region=?, address=? WHERE id=?').run(name, phone || '', region || '', address || '', id);
  res.json({ success: true });
});

// --- 工厂装箱 ---

// 扫箱码开始装箱：返回箱信息 + 已绑子码列表
// 空白箱码（未绑产品）返回 need_product=true，前端引导选择产品+箱规
app.post('/api/factory/pack/start', requireRole('admin', 'factory', 'brand'), (req, res) => {
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
  // 数据隔离：工厂账号只能装自己工厂产品的箱码；品牌管理员只能装自己品牌产品的箱码
  // 空白箱码没有产品，用箱码自身 brand_id 判断归属
  const role = req.session.user.role;
  if (role === 'factory') {
    if (box.product_factory_id && box.product_factory_id !== req.session.user.factory_id) {
      return res.json({ success: false, msg: '该箱码不属于贵工厂，无法装箱' });
    }
    if (box.eff_brand_id != null && req.session.user.brand_id != null && box.eff_brand_id !== req.session.user.brand_id) {
      return res.json({ success: false, msg: '该箱码不属于贵工厂，无法装箱' });
    }
  }
  if (role === 'brand' && !brandAllowed(req.session.user.brand_id, box.eff_brand_id)) {
    return res.json({ success: false, msg: '该箱码不属于你的品牌，无法装箱' });
  }

  const items = db.prepare(`
    SELECT i.item_code, i.created_at FROM items i WHERE i.box_id = ? ORDER BY i.id
  `).all(box.id);

  res.json({
    success: true,
    box,
    items,
    bound_count: items.length,
    box_size: box.product_box_size || 0,   // 产品默认箱规，前端自动带出
    need_product: !box.product_id          // 空白箱码：需先选择产品
  });
});

// 为箱码选择产品+箱规（空白箱码装箱第一步；也可中途换产品）
app.post('/api/factory/pack/set-product', requireRole('admin', 'factory', 'brand'), (req, res) => {
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

  const product = db.prepare('SELECT * FROM products WHERE id=?').get(product_id);
  if (!product) return res.json({ success: false, msg: '产品不存在' });

  const role = req.session.user.role;
  const u = req.session.user;
  // 数据隔离：工厂只能选本厂产品+装本厂/本品牌的箱；品牌管理员限本品牌
  if (role === 'factory') {
    if (product.factory_id && product.factory_id !== u.factory_id) {
      return res.json({ success: false, msg: '该产品不属于贵工厂，无法选用' });
    }
    const boxBrand = box.brand_id;
    if (boxBrand != null && u.brand_id != null && boxBrand !== u.brand_id) {
      return res.json({ success: false, msg: '该箱码不属于贵工厂，无法装箱' });
    }
  }
  if (role === 'brand') {
    if (!brandAllowed(u.brand_id, box.brand_id)) return res.json({ success: false, msg: '该箱码不属于你的品牌' });
    if (!brandAllowed(u.brand_id, product.brand_id)) return res.json({ success: false, msg: '该产品不属于你的品牌' });
  }

  // 该箱已绑定的子码若属于其他产品，禁止切换（防止混装数据错乱）
  const conflict = db.prepare('SELECT COUNT(*) as c FROM items WHERE box_id=? AND product_id IS NOT NULL AND product_id != ?')
    .get(box.id, product_id).c;
  if (conflict > 0) {
    return res.json({ success: false, msg: `该箱已绑定 ${conflict} 个其他产品的子码，不能切换产品，请先联系管理员解绑` });
  }

  db.prepare('UPDATE boxes SET product_id=?, brand_id=COALESCE(?, ?), batch_no=? WHERE id=?')
    .run(product_id, product.brand_id, box.brand_id, batch_no || box.batch_no, box.id);
  logOperation(req, 'pack_set_product', 'box', box.box_code, `箱码「${box.box_code}」设置产品：${product.name}${box_size ? `，箱规 ${box_size}` : ''}`);

  res.json({ success: true, msg: `已选择产品：${product.name}`, box_size: box_size || product.box_size || 0 });
});

// 扫子码绑定到当前箱（带防错）
app.post('/api/factory/pack/scan', requireRole('admin', 'factory', 'brand'), (req, res) => {
  const box_code = extractCode(req.body.box_code);
  const item_code = extractCode(req.body.item_code);
  if (!box_code) return res.json({ success: false, msg: '请先扫箱码' });
  if (!item_code) return res.json({ success: false, msg: '请输入子码' });

  const box = db.prepare(`
    SELECT b.*, p.box_size as product_box_size, p.factory_id as product_factory_id,
      COALESCE(b.brand_id, p.brand_id) as eff_brand_id
    FROM boxes b LEFT JOIN products p ON b.product_id = p.id
    WHERE b.box_code = ?
  `).get(box_code);
  if (!box) return res.json({ success: false, msg: '箱码不存在' });
  if (box.status === 'shipped') return res.json({ success: false, msg: '该箱已发货，不能继续绑定' });
  if (box.status === 'invalid') return res.json({ success: false, msg: '该箱码已作废，不能绑定' });
  // 数据隔离：工厂账号只能操作自己工厂产品的箱码；品牌管理员限本品牌（空白箱码用自身 brand_id）
  const role = req.session.user.role;
  if (role === 'factory') {
    if (box.product_factory_id && box.product_factory_id !== req.session.user.factory_id) {
      return res.json({ success: false, msg: '该箱码不属于贵工厂，无法装箱' });
    }
    if (box.eff_brand_id != null && req.session.user.brand_id != null && box.eff_brand_id !== req.session.user.brand_id) {
      return res.json({ success: false, msg: '该箱码不属于贵工厂，无法装箱' });
    }
  }
  if (role === 'brand' && !brandAllowed(req.session.user.brand_id, box.eff_brand_id)) {
    return res.json({ success: false, msg: '该箱码不属于你的品牌，无法装箱' });
  }

  // 空白箱码必须先选产品再扫子码
  if (!box.product_id) {
    return res.json({ success: false, msg: '该箱还未选择产品，请先在上方选择产品并确认箱规' });
  }

  // 箱规：优先用前端传的（工人可临时改），否则用产品默认箱规
  const boxSize = parseInt(req.body.box_size) || box.product_box_size || 0;

  const item = db.prepare(`
    SELECT i.*, p.name as product_name FROM items i
    LEFT JOIN products p ON i.product_id = p.id
    WHERE i.item_code = ?
  `).get(item_code);
  if (!item) return res.json({ success: false, msg: '子码不存在' });

  const curBound = db.prepare('SELECT COUNT(*) as c FROM items WHERE box_id=?').get(box.id).c;

  // 防错1：已绑定本箱（重复扫）——先于满箱判断，给出更精确的提示
  if (item.box_id === box.id) {
    return res.json({ success: false, msg: `该子码已在本箱（已绑 ${curBound} 个），请勿重复扫码`, bound_count: curBound });
  }
  // 防错0：已扫满箱规，拒绝继续绑定
  if (boxSize > 0 && curBound >= boxSize) {
    return res.json({ success: false, msg: `本箱已装满（${curBound}/${boxSize}），请扫下一个箱码开始新箱`, bound_count: curBound, box_size: boxSize, full: true });
  }
  // 防错2：已绑定其他箱
  if (item.box_id) {
    const otherBox = db.prepare('SELECT box_code FROM boxes WHERE id=?').get(item.box_id);
    return res.json({ success: false, msg: `该子码已绑定箱码 ${otherBox?.box_code || ''}，不能重复装箱`, bound_count: curBound });
  }
  // 防错3：已发货
  if (item.status === 'shipped') {
    return res.json({ success: false, msg: `该子码已发货，不能装箱`, bound_count: curBound });
  }
  // 防错4：产品不符（空白子码 product_id 为空，绑定时自动跟随箱码产品，不算不符）
  if (box.product_id && item.product_id && box.product_id !== item.product_id) {
    return res.json({ success: false, msg: `产品不符！箱码产品与子码产品不一致`, bound_count: curBound });
  }

  // 绑定：空白子码自动跟随箱码产品/品牌
  db.prepare('UPDATE items SET box_id=?, product_id=COALESCE(?, product_id), brand_id=COALESCE(?, brand_id) WHERE id=?')
    .run(box.id, box.product_id, box.eff_brand_id, item.id);
  const count = curBound + 1;
  db.prepare('UPDATE boxes SET item_count=? WHERE id=?').run(count, box.id);

  const items = db.prepare('SELECT item_code, created_at FROM items WHERE box_id=? ORDER BY id').all(box.id);

  res.json({
    success: true,
    msg: `绑定成功`,
    item_code: item_code,
    item_product_name: item.product_name,
    bound_count: count,
    box_size: boxSize,
    full: boxSize > 0 && count >= boxSize,   // 扫满标记，前端自动提示完成
    items: items
  });
});

// --- 仓库发货 ---

// 扫码发货（箱码=整箱发货，子码=散件发货；brand 只能发自己品牌的货给自己品牌的代理商）
app.post('/api/shipments/ship', requireRole('admin', 'warehouse', 'brand'), (req, res) => {
  const code = extractCode(req.body.box_code || req.body.code);
  const distributor_id = req.body.distributor_id;
  const scope = brandScope(req);
  // 操作留痕：优先取当前登录账号，兼容旧的手动填写
  const operator = req.session.user.display_name || req.session.user.username;
  if (!code) return res.json({ success: false, msg: '请输入箱码或子码' });
  if (!distributor_id) return res.json({ success: false, msg: '请选择代理商' });

  const distributor = db.prepare('SELECT * FROM distributors WHERE id=?').get(distributor_id);
  if (!distributor) return res.json({ success: false, msg: '代理商不存在' });
  if (!brandAllowed(scope, distributor.brand_id)) return res.json({ success: false, msg: '该代理商不属于你的品牌' });

  // 先查箱码 → 整箱发货
  const box = db.prepare(`
    SELECT b.*, p.brand_id as product_brand_id FROM boxes b LEFT JOIN products p ON b.product_id=p.id WHERE b.box_code=?
  `).get(code);
  if (box) {
    if (!brandAllowed(scope, box.product_brand_id)) return res.json({ success: false, msg: '该箱码不属于你的品牌' });
    if (box.status === 'shipped') return res.json({ success: false, msg: '该箱已发货，请勿重复发货' });
    const tx = db.transaction(() => {
      db.prepare(`UPDATE boxes SET status=?, distributor_id=?, shipped_at=datetime('now','localtime') WHERE id=?`).run('shipped', distributor_id, box.id);
      db.prepare('UPDATE items SET status=?, distributor_id=? WHERE box_id=?').run('shipped', distributor_id, box.id);
      db.prepare('INSERT INTO shipments (box_id, distributor_id, operator) VALUES (?,?,?)').run(box.id, distributor_id, operator || '');
    });
    tx();

    const itemCount = db.prepare('SELECT COUNT(*) as c FROM items WHERE box_id=?').get(box.id).c;
    return res.json({
      success: true,
      msg: `整箱发货成功！箱码 ${code}（${itemCount}个产品）→ ${distributor.name}（${distributor.region}）`
    });
  }

  // 再查子码 → 散件发货
  const item = db.prepare(`
    SELECT i.*, p.brand_id as product_brand_id FROM items i LEFT JOIN products p ON i.product_id=p.id WHERE i.item_code=?
  `).get(code);
  if (item) {
    if (!brandAllowed(scope, item.product_brand_id)) return res.json({ success: false, msg: '该子码不属于你的品牌' });
    if (item.status === 'shipped') return res.json({ success: false, msg: '该子码已发货，请勿重复发货' });
    const tx = db.transaction(() => {
      db.prepare(`UPDATE items SET status=?, distributor_id=?, shipped_at=datetime('now','localtime') WHERE id=?`).run('shipped', distributor_id, item.id);
      // 记录发货记录（box_id 可为 NULL，散件无箱也记录）
      db.prepare('INSERT INTO shipments (box_id, distributor_id, operator, item_code) VALUES (?,?,?,?)')
        .run(item.box_id || null, distributor_id, operator || '', code);
    });
    tx();
    return res.json({
      success: true,
      msg: `散件发货成功！子码 ${code} → ${distributor.name}（${distributor.region}）`
    });
  }

  res.json({ success: false, msg: '码不存在，请核实是箱码还是子码' });
});

// 获取发货记录（brand 只看自己品牌）
app.get('/api/shipments', requireRole('admin', 'warehouse', 'brand'), (req, res) => {
  const scope = brandScope(req);
  const brandFilter = scope === null ? '' : ' WHERE COALESCE(p_box.brand_id, p_item.brand_id, d.brand_id)=?';
  const params = scope === null ? [] : [scope];
  const shipments = db.prepare(`
    SELECT s.*,
      b.box_code, b.item_count,
      COALESCE(p_box.name, p_item.name) as product_name,
      d.name as distributor_name, d.region as distributor_region
    FROM shipments s
    LEFT JOIN boxes b ON s.box_id = b.id
    LEFT JOIN items i ON s.item_code = i.item_code
    LEFT JOIN products p_box ON b.product_id = p_box.id
    LEFT JOIN products p_item ON i.product_id = p_item.id
    LEFT JOIN distributors d ON s.distributor_id = d.id
    ${brandFilter}
    ORDER BY s.shipped_at DESC
    LIMIT 100
  `).all(...params);
  res.json({ success: true, shipments });
});

// --- 消费者验证 ---

// 验证码
app.get('/api/verify/:code', wrap(async (req, res) => {
  const code = extractCode(req.params.code);
  const scanIp = req.ip || req.connection?.remoteAddress || '';
  const lat = parseFloat(req.query.lat);
  const lng = parseFloat(req.query.lng);
  const latitude = Number.isFinite(lat) ? lat : null;
  const longitude = Number.isFinite(lng) ? lng : null;

  // 扫码位置：优先用户手填 → 其次浏览器GPS定位反查 → 最后IP自动定位
  let scanLocation = req.query.location || '';
  if (!scanLocation) {
    scanLocation = await ipLocate(scanIp);
  }

  // 该码历史扫码信息（用于多次扫码提醒）
  const historyCount = db.prepare('SELECT COUNT(*) as c FROM scan_logs WHERE item_code=?').get(code).c;
  const firstScan = db.prepare(`
    SELECT scanned_at, scan_location, scan_ip FROM scan_logs
    WHERE item_code=? ORDER BY id ASC LIMIT 1
  `).get(code);

  // 先查箱码
  let box = db.prepare(`
    SELECT b.*, p.name as product_name, p.spec as product_spec, p.brand_id as product_brand_id,
      d.name as distributor_name, d.region as distributor_region
    FROM boxes b
    LEFT JOIN products p ON b.product_id = p.id
    LEFT JOIN distributors d ON b.distributor_id = d.id
    WHERE b.box_code = ?
  `).get(code);

  if (box) {
    const items = db.prepare('SELECT item_code, status, scanned_at FROM items WHERE box_id=?').all(box.id);
    const isShipped = box.status === 'shipped';
    // 记录扫码日志（含分级 + 品牌归属）
    let isDiversion = 0;
    if (isShipped) {
      isDiversion = detectDiversion(box.distributor_region, scanLocation);
    }
    db.prepare(`INSERT INTO scan_logs (item_code, box_code, product_name, distributor_name, assigned_region, scan_location, scan_ip, is_diversion, latitude, longitude, brand_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(code, code, box.product_name, box.distributor_name || '', box.distributor_region || '', scanLocation, scanIp, isDiversion, latitude, longitude, box.product_brand_id || null);
    // 串货预警：自动进入预警中心
    if (isDiversion > 0) {
      db.prepare(`INSERT INTO alerts (item_code, box_code, product_name, distributor_name, assigned_region, scan_location, level, brand_id)
        VALUES (?,?,?,?,?,?,?,?)`).run(code, code, box.product_name || '', box.distributor_name || '', box.distributor_region || '', scanLocation, isDiversion, box.product_brand_id || null);
    }

    return res.json({
      success: true,
      type: 'box',
      product_name: box.product_name,
      product_spec: box.product_spec,
      batch_no: box.batch_no,
      status: box.status,
      status_text: isShipped ? '已发货' : '在库',
      distributor: box.distributor_name || '未发货',
      region: box.distributor_region || '',
      is_diversion: isDiversion,
      scan_count: historyCount + 1,
      first_scanned_at: firstScan?.scanned_at || '',
      first_scan_location: firstScan?.scan_location || '',
      resolved_location: scanLocation,
      items: items,
      created_at: box.created_at,
      shipped_at: box.shipped_at || ''
    });
  }

  // 再查子码
  let item = db.prepare(`
    SELECT i.*, b.box_code, p.name as product_name, p.spec as product_spec, p.brand_id as product_brand_id,
      d.name as distributor_name, d.region as distributor_region
    FROM items i
    LEFT JOIN boxes b ON i.box_id = b.id
    LEFT JOIN products p ON i.product_id = p.id
    LEFT JOIN distributors d ON i.distributor_id = d.id
    WHERE i.item_code = ?
  `).get(code);

  if (item) {
    // 更新子码扫码状态
    db.prepare(`UPDATE items SET status=?, scanned_at=datetime('now','localtime'), scan_location=?, scan_ip=? WHERE id=?`)
      .run('scanned', scanLocation, scanIp, item.id);

    // 是否发货：只要绑定过代理商即视为已发货（避免被扫后状态变scanned导致串货检测失效）
    const isShipped = item.distributor_id != null;

    // 串货分级检测
    let isDiversion = 0;
    if (isShipped) {
      isDiversion = detectDiversion(item.distributor_region, scanLocation);
    }

    db.prepare(`INSERT INTO scan_logs (item_code, box_code, product_name, distributor_name, assigned_region, scan_location, scan_ip, is_diversion, latitude, longitude, brand_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(code, item.box_code, item.product_name, item.distributor_name || '', item.distributor_region || '', scanLocation, scanIp, isDiversion, latitude, longitude, item.product_brand_id || null);
    // 串货预警：自动进入预警中心
    if (isDiversion > 0) {
      db.prepare(`INSERT INTO alerts (item_code, box_code, product_name, distributor_name, assigned_region, scan_location, level, brand_id)
        VALUES (?,?,?,?,?,?,?,?)`).run(code, item.box_code || '', item.product_name || '', item.distributor_name || '', item.distributor_region || '', scanLocation, isDiversion, item.product_brand_id || null);
    }

    // 未绑定箱码的情况
    const isBound = !!item.box_code;

    // 扫码抽奖（仅已发货正品首次扫码参与）
    let prize = null;
    if (isBound && isShipped && historyCount === 0) {
      prize = drawPrize(code, scanLocation);
    }

    return res.json({
      success: true,
      type: 'item',
      product_name: item.product_name,
      product_spec: item.product_spec,
      batch_no: item.batch_no,
      box_code: item.box_code || '',
      status: 'scanned',
      status_text: !isBound ? '产品尚未出库，请联系厂家核实' : (isShipped ? '正品已验证' : '产品未发货，请联系厂家'),
      distributor: item.distributor_name || '未发货',
      region: item.distributor_region || '',
      is_diversion: isDiversion,
      scan_count: historyCount + 1,
      first_scanned_at: firstScan?.scanned_at || '',
      first_scan_location: firstScan?.scan_location || '',
      resolved_location: scanLocation,
      prize: prize,
      created_at: item.created_at,
      scanned_at: new Date().toLocaleString('zh-CN')
    });
  }

  res.json({ success: false, msg: '溯源码不存在，请核实！' });
}));

// 动态生成二维码（用于入口二维码等）
app.get('/api/qr', wrap(async (req, res) => {
  const data = req.query.data || '';
  if (!data) return res.json({ success: false, msg: '缺少data参数' });
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
  const settings = Object.fromEntries(db.prepare('SELECT key, value FROM settings').all().map(r => [r.key, r.value]));
  res.json({ success: true, settings });
});

// 保存品牌设置
app.post('/api/settings', requireRole('admin'), (req, res) => {
  const { brand_name, brand_subtitle, logo_text, logo_image, welcome_msg, theme_color, contact_phone, product_images, promo_video, show_scan_count } = req.body;
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

// 上传产品图片（多张，返回URL列表）
app.post('/api/upload/images', requireRole('admin'), (req, res) => {
  imageUpload.array('files', 6)(req, res, (err) => {
    if (err) return res.json({ success: false, msg: err.code === 'LIMIT_FILE_SIZE' ? '单张图片不能超过5MB' : '图片上传失败：' + err.message });
    if (!req.files || req.files.length === 0) return res.json({ success: false, msg: '请选择图片文件（jpg/png/gif/webp）' });
    res.json({ success: true, urls: req.files.map(f => `/uploads/${f.filename}`) });
  });
});

// 上传宣传视频（单个）
app.post('/api/upload/video', requireRole('admin'), (req, res) => {
  videoUpload.single('file')(req, res, (err) => {
    if (err) return res.json({ success: false, msg: err.code === 'LIMIT_FILE_SIZE' ? '视频不能超过100MB' : '视频上传失败：' + err.message });
    if (!req.file) return res.json({ success: false, msg: '请选择视频文件' });
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

// 导出码表（箱码/子码，支持关键词；brand 只导自己品牌）
app.get('/api/export/codes', requireRole('admin', 'brand'), wrap(async (req, res) => {
  const type = req.query.type === 'box' ? 'box' : 'item';
  const keyword = (req.query.keyword || '').trim();
  const scope = brandScope(req);
  const wb = new ExcelJS.Workbook();
  const today = new Date().toISOString().slice(0, 10);

  if (type === 'box') {
    const conds = [];
    const params = [];
    if (scope !== null) { conds.push('COALESCE(b.brand_id, p.brand_id)=?'); params.push(scope); }
    if (keyword) { conds.push('(b.box_code LIKE ? OR p.name LIKE ?)'); params.push(`%${keyword}%`, `%${keyword}%`); }
    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
    const rows = db.prepare(`
      SELECT b.*, p.name as product_name, d.name as distributor_name, d.region as distributor_region,
        (SELECT COUNT(*) FROM items i WHERE i.box_id=b.id AND i.status='scanned') as scanned_count
      FROM boxes b
      LEFT JOIN products p ON b.product_id = p.id
      LEFT JOIN distributors d ON b.distributor_id = d.id
      ${where} ORDER BY b.id DESC
    `).all(...params);
    const ws = wb.addWorksheet('箱码表');
    ws.columns = [
      { header: '箱码', key: 'c1', width: 24 }, { header: '产品', key: 'c2', width: 20 },
      { header: '批次号', key: 'c3', width: 14 }, { header: '箱内数量', key: 'c4', width: 10 },
      { header: '已扫码数', key: 'c5', width: 10 }, { header: '状态', key: 'c6', width: 10 },
      { header: '代理商', key: 'c7', width: 16 }, { header: '代理区域', key: 'c8', width: 16 },
      { header: '发货时间', key: 'c9', width: 20 }, { header: '创建时间', key: 'c10', width: 20 }
    ];
    rows.forEach(r => ws.addRow([r.box_code, r.product_name || '', r.batch_no || '', r.item_count, r.scanned_count || 0,
      r.status === 'shipped' ? '已发货' : '在库', r.distributor_name || '', r.distributor_region || '', r.shipped_at || '', r.created_at]));
    await sendWorkbook(res, wb, `箱码表-${today}.xlsx`);
  } else {
    const conds = [];
    const params = [];
    if (scope !== null) { conds.push('COALESCE(i.brand_id, p.brand_id)=?'); params.push(scope); }
    if (keyword) { conds.push('(i.item_code LIKE ? OR p.name LIKE ?)'); params.push(`%${keyword}%`, `%${keyword}%`); }
    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
    const rows = db.prepare(`
      SELECT i.*, p.name as product_name, b.box_code, d.name as distributor_name, d.region as distributor_region
      FROM items i
      LEFT JOIN products p ON i.product_id = p.id
      LEFT JOIN boxes b ON i.box_id = b.id
      LEFT JOIN distributors d ON i.distributor_id = d.id
      ${where} ORDER BY i.id DESC
    `).all(...params);
    const ws = wb.addWorksheet('子码表');
    ws.columns = [
      { header: '子码', key: 'c1', width: 24 }, { header: '所属箱码', key: 'c2', width: 24 },
      { header: '产品', key: 'c3', width: 20 }, { header: '批次号', key: 'c4', width: 14 },
      { header: '状态', key: 'c5', width: 10 }, { header: '代理商', key: 'c6', width: 16 },
      { header: '代理区域', key: 'c7', width: 16 }, { header: '发货时间', key: 'c8', width: 20 },
      { header: '扫码时间', key: 'c9', width: 20 }, { header: '创建时间', key: 'c10', width: 20 }
    ];
    rows.forEach(r => ws.addRow([r.item_code, r.box_code || '未绑定', r.product_name || '', r.batch_no || '',
      r.status === 'scanned' ? '已扫码' : r.status === 'shipped' ? '已发货' : '在库',
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

// 构造箱/子码查询条件（码列表/码包/打印共用）
function buildCodeConds(type, scope, { keyword, status, ids } = {}) {
  const conds = []; const params = [];
  if (type === 'box') {
    if (scope !== null) { conds.push('COALESCE(b.brand_id, p.brand_id)=?'); params.push(scope); }
    if (keyword) { conds.push('(b.box_code LIKE ? OR p.name LIKE ?)'); params.push(`%${keyword}%`, `%${keyword}%`); }
    if (status === 'shipped') conds.push("b.status='shipped'");
    else if (status === 'in_stock') conds.push("b.status='in_stock'");
    else if (status === 'invalid') conds.push("b.status='invalid'");
    if (ids && ids.length) { conds.push('b.id IN (' + ids.map(() => '?').join(',') + ')'); params.push(...ids); }
  } else {
    if (scope !== null) { conds.push('COALESCE(i.brand_id, p.brand_id)=?'); params.push(scope); }
    if (keyword) { conds.push('(i.item_code LIKE ? OR p.name LIKE ?)'); params.push(`%${keyword}%`, `%${keyword}%`); }
    if (status === 'scanned') conds.push("i.status='scanned'");
    else if (status === 'shipped') conds.push("i.status='shipped'");
    else if (status === 'in_stock') conds.push("i.status='in_stock'");
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

// 码包下载：按筛选条件打包（QR PNG 每码一张 + 清单.csv），发印刷厂直接可用
app.get('/api/codes/package', requireRole('admin', 'brand'), wrap(async (req, res) => {
  const type = req.query.type === 'box' ? 'box' : 'item';
  const keyword = (req.query.keyword || '').trim();
  const status = (req.query.status || '').trim();
  const ids = (req.query.ids || '').split(',').map(s => parseInt(s)).filter(n => Number.isInteger(n) && n > 0);
  const scope = brandScope(req);
  const baseUrl = getBaseUrl(req);
  const { where, params } = buildCodeConds(type, scope, { keyword, status, ids });

  const rows = type === 'box'
    ? db.prepare(`SELECT b.*, p.name as product_name, br.name as brand_name FROM boxes b LEFT JOIN products p ON b.product_id=p.id LEFT JOIN brands br ON br.id=COALESCE(b.brand_id,p.brand_id) ${where} ORDER BY b.id ASC LIMIT 5000`).all(...params)
    : db.prepare(`SELECT i.*, p.name as product_name, br.name as brand_name FROM items i LEFT JOIN products p ON i.product_id=p.id LEFT JOIN brands br ON br.id=COALESCE(i.brand_id,p.brand_id) ${where} ORDER BY i.id ASC LIMIT 5000`).all(...params);

  if (!rows.length) return res.json({ success: false, msg: '没有符合条件的码' });

  const entries = [];
  const csvLines = [type === 'box' ? '\uFEFF箱码,品牌,产品,批次号,数量,状态,创建时间' : '\uFEFF子码,品牌,产品,批次号,所属箱码,状态,创建时间'];
  for (const r of rows) {
    const code = r.box_code || r.item_code;
    const png = await getQrBuffer(code, type === 'box' ? 300 : 200, baseUrl);
    entries.push({ name: `${type === 'box' ? '箱码' : '子码'}/${code}.png`, data: png });
    // 带品牌名+码值的矢量标签（印刷制版推荐）
    const svg = await buildLabelSvg(code, r.brand_name || '', type === 'box', baseUrl);
    entries.push({ name: `带品牌标签/${code}.svg`, data: Buffer.from(svg, 'utf8') });
    const st = r.status === 'shipped' ? '已发货' : r.status === 'scanned' ? '已扫码' : r.status === 'invalid' ? '已作废' : '在库';
    if (type === 'box') {
      csvLines.push([code, r.brand_name || '', r.product_name || '未绑定', r.batch_no || '', r.item_count || 0, st, r.created_at].map(v => `"${String(v).replace(/"/g, '""')}"`).join(','));
    } else {
      let boxCode = '';
      if (r.box_id) boxCode = (db.prepare('SELECT box_code FROM boxes WHERE id=?').get(r.box_id) || {}).box_code || '';
      csvLines.push([code, r.brand_name || '', r.product_name || '未绑定', r.batch_no || '', boxCode, st, r.created_at].map(v => `"${String(v).replace(/"/g, '""')}"`).join(','));
    }
  }
  entries.push({ name: '清单.csv', data: Buffer.from(csvLines.join('\r\n'), 'utf8') });
  entries.push({ name: '使用说明.txt', data: Buffer.from(
    `${type === 'box' ? '箱码' : '子码'}码包\r\n` +
    `共 ${rows.length} 个二维码。\r\n\r\n` +
    `【带品牌标签/】推荐使用：矢量 SVG 标签图（二维码+品牌名+码值），制版清晰无锯齿，可直接用于包装印刷。文件以码值命名（如 ABC123.svg）。\r\n` +
    `【${type === 'box' ? '箱码' : '子码'}/】纯二维码 PNG 图（${type === 'box' ? 300 : 200}x${type === 'box' ? 300 : 200}px），以码值命名，仅含二维码。\r\n` +
    `【清单.csv】可用 Excel 打开核对（含品牌、产品、批次、状态）。\r\n` +
    `生成时间：${new Date().toLocaleString('zh-CN')}\r\n`, 'utf8') });

  const zip = buildZip(entries);
  const today = new Date().toISOString().slice(0, 10);
  const fname = `${type === 'box' ? '箱码' : '子码'}码包-${today}.zip`;
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(fname)}`);
  res.send(zip);
}));

// 导出扫码日志（brand 只导自己品牌）
app.get('/api/export/logs', requireRole('admin', 'brand'), wrap(async (req, res) => {
  const scope = brandScope(req);
  const rows = scope === null
    ? db.prepare('SELECT * FROM scan_logs ORDER BY scanned_at DESC LIMIT 50000').all()
    : db.prepare('SELECT * FROM scan_logs WHERE brand_id=? ORDER BY scanned_at DESC LIMIT 50000').all(scope);
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('扫码日志');
  ws.columns = [
    { header: '扫码时间', key: 'c1', width: 20 }, { header: '溯源码', key: 'c2', width: 24 },
    { header: '箱码', key: 'c3', width: 24 }, { header: '产品', key: 'c4', width: 20 },
    { header: '代理商', key: 'c5', width: 16 }, { header: '指定区域', key: 'c6', width: 16 },
    { header: '扫码位置', key: 'c7', width: 20 }, { header: '纬度', key: 'c8', width: 10 },
    { header: '经度', key: 'c9', width: 10 }, { header: 'IP', key: 'c10', width: 16 },
    { header: '串货状态', key: 'c11', width: 16 }
  ];
  rows.forEach(r => ws.addRow([r.scanned_at, r.item_code, r.box_code || '', r.product_name || '', r.distributor_name || '',
    r.assigned_region || '', r.scan_location || '', r.latitude ?? '', r.longitude ?? '', r.scan_ip || '', diversionText(r.is_diversion)]));
  const today = new Date().toISOString().slice(0, 10);
  await sendWorkbook(res, wb, `扫码日志-${today}.xlsx`);
}));

// 导出发货记录（brand 只导自己品牌）
app.get('/api/export/shipments', requireRole('admin', 'brand'), wrap(async (req, res) => {
  const scope = brandScope(req);
  const brandFilter = scope === null ? '' : ' WHERE COALESCE(p_box.brand_id, p_item.brand_id, d.brand_id)=?';
  const params = scope === null ? [] : [scope];
  const rows = db.prepare(`
    SELECT s.*,
      b.box_code, b.item_count,
      COALESCE(p_box.name, p_item.name) as product_name,
      d.name as distributor_name, d.region as distributor_region
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
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('发货记录');
  ws.columns = [
    { header: '发货时间', key: 'c1', width: 20 }, { header: '类型', key: 'c2', width: 8 },
    { header: '码值', key: 'c3', width: 24 }, { header: '产品', key: 'c4', width: 20 },
    { header: '数量', key: 'c5', width: 8 }, { header: '代理商', key: 'c6', width: 16 },
    { header: '区域', key: 'c7', width: 16 }, { header: '操作人', key: 'c8', width: 12 }
  ];
  rows.forEach(r => ws.addRow([r.shipped_at, r.item_code ? '散件' : '整箱', r.item_code || r.box_code || '',
    r.product_name || '', r.item_count || (r.item_code ? 1 : 0), r.distributor_name || '', r.distributor_region || '', r.operator || '']));
  const today = new Date().toISOString().slice(0, 10);
  await sendWorkbook(res, wb, `发货记录-${today}.xlsx`);
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

// 串货分级检测：返回 0=正常 1=轻度(同省跨市) 2=重度(跨省)
function detectDiversion(assignedRegion, scanLocation) {
  if (!assignedRegion || !scanLocation) return 0;
  const a = String(assignedRegion).trim();
  const s = String(scanLocation).trim();
  // 完全匹配或互为包含 → 正常
  if (a.includes(s) || s.includes(a)) return 0;

  // 提取省级（取常见省级关键词）
  const provinceKeys = ['北京', '上海', '天津', '重庆', '黑龙江', '内蒙古', '新疆', '西藏', '广西', '宁夏',
    '河北', '山西', '辽宁', '吉林', '江苏', '浙江', '安徽', '福建', '江西', '山东',
    '河南', '湖北', '湖南', '广东', '海南', '四川', '贵州', '云南', '陕西', '甘肃', '青海', '台湾', '香港', '澳门'];
  const getProvince = (str) => {
    for (const p of provinceKeys) {
      if (str.includes(p)) return p;
    }
    // 单字省级（如 粤/湘）不在字符串内时，尝试匹配 "省" 前面的字
    const m = str.match(/([\u4e00-\u9fa5]{2})省/);
    return m ? m[1] : '';
  };
  const pa = getProvince(a), ps = getProvince(s);
  if (pa && ps && pa !== ps) return 2; // 跨省
  return 1; // 同省跨市或无法判断 → 轻度
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
app.get('/alerts', requireRole('admin', 'brand'), (req, res) => {
  const scope = brandScope(req);
  const alerts = scope === null
    ? db.prepare('SELECT * FROM alerts ORDER BY handled ASC, id DESC LIMIT 500').all()
    : db.prepare('SELECT * FROM alerts WHERE brand_id=? ORDER BY handled ASC, id DESC LIMIT 500').all(scope);
  res.render('alerts', { alerts });
});

// 预警列表 API（brand 只看自己品牌）
app.get('/api/alerts', requireRole('admin', 'brand'), (req, res) => {
  const scope = brandScope(req);
  const alerts = scope === null
    ? db.prepare('SELECT * FROM alerts ORDER BY handled ASC, id DESC LIMIT 500').all()
    : db.prepare('SELECT * FROM alerts WHERE brand_id=? ORDER BY handled ASC, id DESC LIMIT 500').all(scope);
  const unread = scope === null
    ? db.prepare('SELECT COUNT(*) as c FROM alerts WHERE handled=0').get().c
    : db.prepare('SELECT COUNT(*) as c FROM alerts WHERE handled=0 AND brand_id=?').get(scope).c;
  res.json({ success: true, alerts, unread });
});

// 标记已处理
app.post('/api/alerts/:id/handle', requireRole('admin', 'brand'), (req, res) => {
  const scope = brandScope(req);
  const a = db.prepare('SELECT * FROM alerts WHERE id=?').get(req.params.id);
  if (!a) return res.json({ success: false, msg: '预警不存在' });
  if (!brandAllowed(scope, a.brand_id)) return res.json({ success: false, msg: '没有权限处理该预警' });
  db.prepare(`UPDATE alerts SET handled=1, handled_at=datetime('now','localtime') WHERE id=?`).run(req.params.id);
  res.json({ success: true });
});
// 全部标记已处理（brand 只处理自己品牌的）
app.post('/api/alerts/handle-all', requireRole('admin', 'brand'), (req, res) => {
  const scope = brandScope(req);
  if (scope === null) {
    db.prepare(`UPDATE alerts SET handled=1, handled_at=datetime('now','localtime') WHERE handled=0`).run();
  } else {
    db.prepare(`UPDATE alerts SET handled=1, handled_at=datetime('now','localtime') WHERE handled=0 AND brand_id=?`).run(scope);
  }
  res.json({ success: true });
});

// ===================== 账号管理（admin） =====================

// 账号管理页（admin 看全部；brand 只看自己品牌的账号，不能管理 admin/brand 角色）
app.get('/users', requireRole('admin', 'brand'), (req, res) => {
  const scope = brandScope(req);
  const baseUserSql = `
    SELECT u.id, u.username, u.display_name, u.role, u.distributor_id, u.factory_id, u.brand_id, u.enabled, u.created_at, u.last_login_at,
      d.name as distributor_name, f.name as factory_name, b.name as brand_name
    FROM users u
    LEFT JOIN distributors d ON u.distributor_id = d.id
    LEFT JOIN factories f ON u.factory_id = f.id
    LEFT JOIN brands b ON u.brand_id = b.id
  `;
  const users = scope === null
    ? db.prepare(baseUserSql + ' ORDER BY u.id').all()
    : db.prepare(baseUserSql + ' WHERE u.brand_id=? ORDER BY u.id').all(scope);
  const distributors = scope === null
    ? db.prepare('SELECT id, name, region FROM distributors ORDER BY id DESC').all()
    : db.prepare('SELECT id, name, region FROM distributors WHERE brand_id=? ORDER BY id DESC').all(scope);
  const factories = scope === null
    ? db.prepare('SELECT id, name FROM factories ORDER BY id DESC').all()
    : db.prepare('SELECT id, name FROM factories WHERE brand_id=? ORDER BY id DESC').all(scope);
  const invitations = scope === null
    ? db.prepare(`
        SELECT i.id, i.code, i.role, i.note, i.status, i.used_by, i.used_at, i.created_at, b.name as brand_name
        FROM invitations i LEFT JOIN brands b ON i.brand_id=b.id
        ORDER BY i.id DESC LIMIT 200
      `).all()
    : db.prepare(`
        SELECT i.id, i.code, i.role, i.note, i.status, i.used_by, i.used_at, i.created_at, b.name as brand_name
        FROM invitations i LEFT JOIN brands b ON i.brand_id=b.id
        WHERE i.brand_id=? ORDER BY i.id DESC LIMIT 200
      `).all(scope);
  const brands = scope === null
    ? db.prepare('SELECT id, name, contact, enabled, created_at FROM brands ORDER BY id').all()
    : [];
  res.render('users', { users, distributors, factories, invitations, brands, roleNames: ROLE_NAMES });
});

// 账号列表（同页面过滤规则）
app.get('/api/users', requireRole('admin', 'brand'), (req, res) => {
  const scope = brandScope(req);
  const baseUserSql = `
    SELECT u.id, u.username, u.display_name, u.role, u.distributor_id, u.factory_id, u.brand_id, u.enabled, u.created_at, u.last_login_at,
      d.name as distributor_name, f.name as factory_name, b.name as brand_name
    FROM users u
    LEFT JOIN distributors d ON u.distributor_id = d.id
    LEFT JOIN factories f ON u.factory_id = f.id
    LEFT JOIN brands b ON u.brand_id = b.id
  `;
  const users = scope === null
    ? db.prepare(baseUserSql + ' ORDER BY u.id').all()
    : db.prepare(baseUserSql + ' WHERE u.brand_id=? ORDER BY u.id').all(scope);
  res.json({ success: true, users });
});

// 新建账号（admin 可建任意角色并指定品牌；brand 只能建本品牌的工厂/代理商/品牌方账号）
app.post('/api/users', requireRole('admin', 'brand'), (req, res) => {
  const { username, password, display_name, role, distributor_id, factory_id } = req.body;
  const scope = brandScope(req);
  const uname = String(username || '').trim();
  if (!uname || !password) return res.json({ success: false, msg: '账号和密码不能为空' });
  if (!/^[a-zA-Z0-9_]{3,20}$/.test(uname)) return res.json({ success: false, msg: '账号需为3-20位字母/数字/下划线' });
  if (String(password).length < 6) return res.json({ success: false, msg: '密码至少6位' });
  if (!ROLE_NAMES[role]) return res.json({ success: false, msg: '角色不合法' });
  if (scope !== null && !['factory', 'warehouse', 'distributor'].includes(role)) {
    return res.json({ success: false, msg: '品牌管理员只能创建工厂/品牌方/代理商账号' });
  }
  if (db.prepare('SELECT 1 FROM users WHERE username=?').get(uname)) return res.json({ success: false, msg: '该账号已存在' });
  // 品牌归属：brand 固定自己品牌；admin 按表单选择或从所绑实体带出
  let brand_id = scope !== null ? scope : (parseInt(req.body.brand_id) || null);
  if (role === 'brand' && !brand_id) return res.json({ success: false, msg: '品牌管理员账号必须指定所属品牌' });
  if (role === 'distributor') {
    if (!distributor_id) return res.json({ success: false, msg: '代理商账号必须绑定代理商' });
    const d = db.prepare('SELECT * FROM distributors WHERE id=?').get(distributor_id);
    if (!d) return res.json({ success: false, msg: '代理商不存在' });
    if (!brandAllowed(scope, d.brand_id)) return res.json({ success: false, msg: '该代理商不属于你的品牌' });
    brand_id = d.brand_id || brand_id;
  }
  if (role === 'factory') {
    if (!factory_id) return res.json({ success: false, msg: '工厂账号必须绑定工厂' });
    const f = db.prepare('SELECT * FROM factories WHERE id=?').get(factory_id);
    if (!f) return res.json({ success: false, msg: '工厂不存在' });
    if (!brandAllowed(scope, f.brand_id)) return res.json({ success: false, msg: '该工厂不属于你的品牌' });
    brand_id = f.brand_id || brand_id;
  }
  db.prepare('INSERT INTO users (username, password_hash, display_name, role, distributor_id, factory_id, brand_id) VALUES (?,?,?,?,?,?,?)')
    .run(uname, hashPassword(password), String(display_name || '').trim(), role,
      role === 'distributor' ? distributor_id : null,
      role === 'factory' ? factory_id : null,
      brand_id || null);
  logOperation(req, 'create_user', 'user', uname, `账号「${uname}」（${ROLE_NAMES[role]}）已创建`);
  res.json({ success: true, msg: '账号已创建' });
});

// 工厂列表/新建（admin 手动管理工厂实体；brand 只能看/建自己品牌的工厂）
app.get('/api/factories', requireRole('admin', 'brand'), (req, res) => {
  const scope = brandScope(req);
  const factories = scope === null
    ? db.prepare('SELECT f.id, f.name, f.contact, f.created_at, b.name as brand_name FROM factories f LEFT JOIN brands b ON f.brand_id=b.id ORDER BY f.id DESC').all()
    : db.prepare('SELECT f.id, f.name, f.contact, f.created_at, b.name as brand_name FROM factories f LEFT JOIN brands b ON f.brand_id=b.id WHERE f.brand_id=? ORDER BY f.id DESC').all(scope);
  res.json({ success: true, factories });
});
app.post('/api/factories', requireRole('admin', 'brand'), (req, res) => {
  const name = String(req.body.name || '').trim();
  const contact = String(req.body.contact || '').trim();
  const scope = brandScope(req);
  if (!name) return res.json({ success: false, msg: '工厂名称不能为空' });
  let brand_id = scope !== null ? scope : (parseInt(req.body.brand_id) || null);
  if (brand_id && !db.prepare('SELECT 1 FROM brands WHERE id=? AND enabled=1').get(brand_id)) {
    return res.json({ success: false, msg: '所选品牌不存在或已停用' });
  }
  const r = db.prepare('INSERT INTO factories (name, contact, brand_id) VALUES (?,?,?)').run(name, contact, brand_id || null);
  res.json({ success: true, id: r.lastInsertRowid, msg: '工厂已创建' });
});

// 修改账号（重置密码 / 启停 / 改角色；brand 只能操作本品牌账号且不能改成 admin/brand）
app.put('/api/users/:id', requireRole('admin', 'brand'), (req, res) => {
  const id = req.params.id;
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(id);
  if (!user) return res.json({ success: false, msg: '账号不存在' });
  const scope = brandScope(req);
  if (!brandAllowed(scope, user.brand_id)) return res.json({ success: false, msg: '没有权限操作该账号' });
  const { password, display_name, role, distributor_id, factory_id, enabled, brand_id } = req.body;
  if (password !== undefined && String(password).length > 0) {
    if (String(password).length < 6) return res.json({ success: false, msg: '密码至少6位' });
    db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hashPassword(password), id);
  }
  if (display_name !== undefined) db.prepare('UPDATE users SET display_name=? WHERE id=?').run(String(display_name).trim(), id);
  if (role !== undefined && ROLE_NAMES[role]) {
    // 品牌管理员编辑平台/品牌管理员账号：角色保持不变（无权修改），仅允许改姓名/密码/启停
    const keepRole = scope !== null && ['admin', 'brand'].includes(user.role);
    const newRole = keepRole ? user.role : role;
    if (user.username === 'admin' && newRole !== 'admin') return res.json({ success: false, msg: '内置 admin 账号不能降级' });
    if (scope !== null && !['factory', 'warehouse', 'distributor'].includes(newRole)) {
      return res.json({ success: false, msg: '品牌管理员不能设置该角色' });
    }
    if (newRole === 'distributor' && !distributor_id && user.distributor_id === null) {
      return res.json({ success: false, msg: '代理商账号必须绑定代理商' });
    }
    if (newRole === 'factory' && !factory_id && user.factory_id === null) {
      return res.json({ success: false, msg: '工厂账号必须绑定工厂' });
    }
    // 品牌归属：admin 可为品牌管理员改绑品牌；工厂/代理商账号从所绑实体带出
    let newBrandId = user.brand_id;
    if (newRole === 'brand') {
      if (scope === null && brand_id !== undefined && brand_id !== null) {
        const b = db.prepare('SELECT id FROM brands WHERE id=?').get(brand_id);
        if (!b) return res.json({ success: false, msg: '品牌不存在' });
        newBrandId = b.id;
      }
      if (!newBrandId) return res.json({ success: false, msg: '品牌管理员账号必须绑定品牌' });
    } else if (newRole === 'distributor' && (distributor_id || user.distributor_id)) {
      const d = db.prepare('SELECT brand_id FROM distributors WHERE id=?').get(distributor_id || user.distributor_id);
      if (d && d.brand_id) newBrandId = d.brand_id;
    } else if (newRole === 'factory' && (factory_id || user.factory_id)) {
      const f = db.prepare('SELECT brand_id FROM factories WHERE id=?').get(factory_id || user.factory_id);
      if (f && f.brand_id) newBrandId = f.brand_id;
    } else if (newRole === 'admin') {
      newBrandId = null;
    } else if (newRole === 'warehouse') {
      newBrandId = scope === null ? (brand_id !== undefined ? (parseInt(brand_id) || null) : user.brand_id) : scope;
    }
    db.prepare('UPDATE users SET role=?, distributor_id=?, factory_id=?, brand_id=? WHERE id=?')
      .run(newRole,
        newRole === 'distributor' ? (distributor_id || user.distributor_id) : null,
        newRole === 'factory' ? (factory_id || user.factory_id) : null,
        newBrandId,
        id);
  }
  if (enabled !== undefined) {
    if (user.username === 'admin' && !enabled) return res.json({ success: false, msg: '内置 admin 账号不能停用' });
    db.prepare('UPDATE users SET enabled=? WHERE id=?').run(enabled ? 1 : 0, id);
  }
  res.json({ success: true, msg: '账号已更新' });
});

// 删除账号
app.delete('/api/users/:id', requireRole('admin', 'brand'), (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id);
  if (!user) return res.json({ success: false, msg: '账号不存在' });
  if (user.username === 'admin') return res.json({ success: false, msg: '内置 admin 账号不能删除' });
  if (!brandAllowed(brandScope(req), user.brand_id)) return res.json({ success: false, msg: '没有权限删除该账号' });
  db.prepare('DELETE FROM users WHERE id=?').run(user.id);
  res.json({ success: true, msg: '账号已删除' });
});

// ===================== 个人资料 / 修改密码 =====================

app.get('/profile', requireLogin, (req, res) => {
  res.render('profile', { user: req.session.user, roleNames: ROLE_NAMES });
});

app.post('/api/profile/password', requireLogin, (req, res) => {
  const { old_password, new_password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(req.session.user.id);
  if (!user || !verifyPassword(String(old_password || ''), user.password_hash)) {
    return res.json({ success: false, msg: '原密码错误' });
  }
  if (String(new_password || '').length < 6) return res.json({ success: false, msg: '新密码至少6位' });
  db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hashPassword(new_password), user.id);
  res.json({ success: true, msg: '密码已修改' });
});

// ===================== 代理商自助端 =====================

app.get('/portal', requireRole('distributor', 'admin', 'brand'), (req, res) => {
  // admin/brand 可带 ?distributor_id= 查看任意代理商视角（brand 限本品牌）
  const scope = brandScope(req);
  const did = req.session.user.role === 'distributor'
    ? req.session.user.distributor_id
    : (parseInt(req.query.distributor_id) || null);
  if (!did) return res.status(400).send('缺少代理商参数，<a href="/distributors">返回代理商管理</a>');
  const distributor = db.prepare('SELECT * FROM distributors WHERE id=?').get(did);
  if (!distributor) return res.status(404).send('代理商不存在');
  if (!brandAllowed(scope, distributor.brand_id)) return res.status(403).send('该代理商不属于你的品牌');

  const stats = {
    boxes: db.prepare('SELECT COUNT(*) as c FROM boxes WHERE distributor_id=?').get(did).c,
    items: db.prepare('SELECT COUNT(*) as c FROM items WHERE distributor_id=?').get(did).c,
    scanned: db.prepare("SELECT COUNT(*) as c FROM items WHERE distributor_id=? AND status='scanned'").get(did).c,
    diversions: db.prepare('SELECT COUNT(*) as c FROM scan_logs WHERE is_diversion>0 AND distributor_name=?').get(distributor.name).c
  };
  const boxes = db.prepare(`
    SELECT b.*, p.name as product_name,
      (SELECT COUNT(*) FROM items i WHERE i.box_id=b.id AND i.status='scanned') as scanned_count
    FROM boxes b LEFT JOIN products p ON b.product_id=p.id
    WHERE b.distributor_id=? ORDER BY b.shipped_at DESC LIMIT 200
  `).all(did);
  const scans = db.prepare(`
    SELECT * FROM scan_logs WHERE distributor_name=? ORDER BY id DESC LIMIT 100
  `).all(distributor.name);
  res.render('portal', { distributor, stats, boxes, scans, isSelf: req.session.user.role === 'distributor' });
});

// ===================== 数据库备份 =====================

// 立即备份并下载（admin）
app.get('/api/backup/download', requireRole('admin'), wrap(async (req, res) => {
  const backupDir = path.join(__dirname, 'data', 'backups');
  fs.mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
  const file = path.join(backupDir, `traceability-${stamp}.db`);
  await db.backup(file);
  res.download(file, `溯源系统备份-${stamp}.db`, (err) => {
    if (err && !res.headersSent) res.status(500).json({ success: false, msg: '备份下载失败' });
  });
}));

// 备份列表（admin）
app.get('/api/backups', requireRole('admin'), (req, res) => {
  const backupDir = path.join(__dirname, 'data', 'backups');
  let files = [];
  try {
    files = fs.readdirSync(backupDir).filter(f => f.endsWith('.db'))
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
  if (!/^[\w.-]+\.db$/.test(name)) return res.status(400).json({ success: false, msg: '文件名不合法' });
  const file = path.join(__dirname, 'data', 'backups', name);
  if (!fs.existsSync(file)) return res.status(404).json({ success: false, msg: '备份不存在' });
  res.download(file, name);
});

// --- 统计 API ---
app.get('/api/stats', requireRole('admin', 'brand'), (req, res) => {
  const scope = brandScope(req);
  if (scope === null) {
    const stats = {
      total_boxes: db.prepare('SELECT COUNT(*) as c FROM boxes').get().c,
      total_items: db.prepare('SELECT COUNT(*) as c FROM items').get().c,
      shipped_boxes: db.prepare("SELECT COUNT(*) as c FROM boxes WHERE status='shipped'").get().c,
      scanned_items: db.prepare("SELECT COUNT(*) as c FROM items WHERE status='scanned'").get().c,
      diversions: db.prepare('SELECT COUNT(*) as c FROM scan_logs WHERE is_diversion>0').get().c,
      total_scans: db.prepare('SELECT COUNT(*) as c FROM scan_logs').get().c,
    };
    return res.json({ success: true, stats });
  }
  const stats = {
    total_boxes: db.prepare('SELECT COUNT(*) as c FROM boxes b JOIN products p ON b.product_id=p.id WHERE p.brand_id=?').get(scope).c,
    total_items: db.prepare('SELECT COUNT(*) as c FROM items i JOIN products p ON i.product_id=p.id WHERE p.brand_id=?').get(scope).c,
    shipped_boxes: db.prepare("SELECT COUNT(*) as c FROM boxes b JOIN products p ON b.product_id=p.id WHERE b.status='shipped' AND p.brand_id=?").get(scope).c,
    scanned_items: db.prepare("SELECT COUNT(*) as c FROM items i JOIN products p ON i.product_id=p.id WHERE i.status='scanned' AND p.brand_id=?").get(scope).c,
    diversions: db.prepare('SELECT COUNT(*) as c FROM scan_logs WHERE is_diversion>0 AND brand_id=?').get(scope).c,
    total_scans: db.prepare('SELECT COUNT(*) as c FROM scan_logs WHERE brand_id=?').get(scope).c,
  };
  res.json({ success: true, stats });
});

// ===================== 全局错误处理 =====================

// 404 兜底
app.use((req, res) => {
  res.status(404).json({ success: false, msg: '接口不存在' });
});

// 全局错误中间件：任何路由抛出的异常都会到这里，不会让进程崩溃
app.use((err, req, res, next) => {
  console.error(`[${new Date().toLocaleString('zh-CN')}] 接口错误:`, req.method, req.url, err.message);
  if (res.headersSent) return next(err);
  res.status(500).json({ success: false, msg: '服务器繁忙，请稍后重试' });
});

// 进程级兜底：未捕获异常不直接崩溃，记录日志后保持服务运行
process.on('uncaughtException', (err) => {
  console.error(`[${new Date().toLocaleString('zh-CN')}] 未捕获异常:`, err);
});
process.on('unhandledRejection', (reason) => {
  console.error(`[${new Date().toLocaleString('zh-CN')}] 未处理的Promise拒绝:`, reason);
});

// 启动服务
app.listen(PORT, '127.0.0.1', () => {
  console.log(`\n====================================`);
  console.log(`  溯源码系统已启动`);
  console.log(`  管理后台: http://localhost:${PORT}`);
  console.log(`  消费者验证: http://localhost:${PORT}/v/溯源码`);
  console.log(`====================================\n`);
});
