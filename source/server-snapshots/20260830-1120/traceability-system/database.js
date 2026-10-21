const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, 'data', 'traceability.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true, mode: 0o700 });
const db = new Database(DB_PATH);

// 开启 WAL 模式，提升并发性能
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

function initDatabase() {
  // 产品表
  db.exec(`
    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      spec TEXT DEFAULT '',
      batch_no TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now','localtime'))
    )
  `);

  // 箱码表（父码）
  // product_id 允许为空：可先生成空白箱码，装箱时再选择产品绑定
  db.exec(`
    CREATE TABLE IF NOT EXISTS boxes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      box_code TEXT UNIQUE NOT NULL,
      product_id INTEGER,
      brand_id INTEGER,
      batch_no TEXT DEFAULT '',
      item_count INTEGER DEFAULT 0,
      status TEXT DEFAULT 'in_stock',  -- in_stock(在库) / shipped(已发货)
      distributor_id INTEGER,
      shipped_at TEXT,
      created_at TEXT DEFAULT (datetime('now','localtime')),
      FOREIGN KEY (product_id) REFERENCES products(id),
      FOREIGN KEY (distributor_id) REFERENCES distributors(id)
    )
  `);

  // 子码表（单品码）
  // box_id 允许为空：子码可独立生成，后续再绑定到任意箱码
  // product_id 允许为空：可先生成空白子码，装箱绑定时跟随箱码产品
  db.exec(`
    CREATE TABLE IF NOT EXISTS items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_code TEXT UNIQUE NOT NULL,
      box_id INTEGER,
      product_id INTEGER,
      brand_id INTEGER,
      batch_no TEXT DEFAULT '',
      status TEXT DEFAULT 'in_stock',  -- in_stock / shipped / scanned
      distributor_id INTEGER,
      scanned_at TEXT,
      scan_location TEXT,
      scan_ip TEXT,
      created_at TEXT DEFAULT (datetime('now','localtime')),
      FOREIGN KEY (box_id) REFERENCES boxes(id),
      FOREIGN KEY (product_id) REFERENCES products(id),
      FOREIGN KEY (distributor_id) REFERENCES distributors(id)
    )
  `);

  // 代理商表
  db.exec(`
    CREATE TABLE IF NOT EXISTS distributors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      phone TEXT DEFAULT '',
      region TEXT DEFAULT '',  -- 负责区域，如"广东省深圳市"
      address TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now','localtime'))
    )
  `);

  // 发货记录表
  db.exec(`
    CREATE TABLE IF NOT EXISTS shipments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      box_id INTEGER NOT NULL,
      distributor_id INTEGER NOT NULL,
      shipped_at TEXT DEFAULT (datetime('now','localtime')),
      operator TEXT DEFAULT '',
      FOREIGN KEY (box_id) REFERENCES boxes(id),
      FOREIGN KEY (distributor_id) REFERENCES distributors(id)
    )
  `);

  // 扫码日志表
  db.exec(`
    CREATE TABLE IF NOT EXISTS scan_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_code TEXT NOT NULL,
      box_code TEXT,
      product_name TEXT,
      distributor_name TEXT,
      assigned_region TEXT,
      scan_location TEXT,
      scan_ip TEXT,
      is_diversion INTEGER DEFAULT 0,  -- 0=正常 1=轻度串货(同省跨市) 2=重度串货(跨省)
      scanned_at TEXT DEFAULT (datetime('now','localtime'))
    )
  `);

  // 品牌设置表（key-value）
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    )
  `);

  // 营销活动表
  db.exec(`
    CREATE TABLE IF NOT EXISTS campaigns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      start_date TEXT DEFAULT '',
      end_date TEXT DEFAULT '',
      win_rate INTEGER DEFAULT 0,          -- 中奖率（百分比）
      prize_type TEXT DEFAULT 'thanks',    -- red_packet红包 / coupon优惠券 / goods实物 / thanks谢谢参与
      prize_name TEXT DEFAULT '',
      prize_min REAL DEFAULT 0,
      prize_max REAL DEFAULT 0,
      enabled INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    )
  `);

  // 中奖记录表
  db.exec(`
    CREATE TABLE IF NOT EXISTS prize_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_code TEXT NOT NULL,
      campaign_id INTEGER,
      prize_type TEXT,
      prize_name TEXT,
      prize_value TEXT,
      scan_location TEXT,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    )
  `);

  // 系统用户表（登录认证 + 角色权限）
  // role: admin(平台管理员) / brand(品牌管理员) / brand_staff(品牌方工作账号) / factory(工厂装箱) / warehouse(品牌方) / distributor(代理商自助)
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      display_name TEXT DEFAULT '',
      phone TEXT DEFAULT '',
      role TEXT DEFAULT 'admin',
      distributor_id INTEGER,
      enabled INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now','localtime')),
      last_login_at TEXT
    )
  `);
  // 迁移：旧库无 phone 列，动态添加
  const userCols = db.prepare("PRAGMA table_info(users)").all().map(c => c.name);
  if (!userCols.includes('phone')) {
    try { db.exec("ALTER TABLE users ADD COLUMN phone TEXT DEFAULT ''"); } catch (e) {}
  }

  // 工厂表（多工厂数据隔离：每个工厂账号绑定一个工厂实体）
  db.exec(`
    CREATE TABLE IF NOT EXISTS factories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      contact TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now','localtime'))
    )
  `);

  // 邀请码表（admin 生成，合作工厂/代理商凭码自助注册账号）
  db.exec(`
    CREATE TABLE IF NOT EXISTS invitations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT UNIQUE NOT NULL,
      role TEXT NOT NULL,                -- factory / distributor
      note TEXT DEFAULT '',              -- 备注（发给哪家工厂/代理商）
      status INTEGER DEFAULT 0,          -- 0=未使用 1=已使用 2=已作废
      used_by TEXT DEFAULT '',           -- 注册成功的账号名
      used_at TEXT,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    )
  `);

  // 串货预警表（验证接口检测到串货自动生成，后台预警中心展示）
  db.exec(`
    CREATE TABLE IF NOT EXISTS alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_code TEXT NOT NULL,
      box_code TEXT DEFAULT '',
      product_name TEXT DEFAULT '',
      distributor_name TEXT DEFAULT '',
      assigned_region TEXT DEFAULT '',
      scan_location TEXT DEFAULT '',
      level INTEGER DEFAULT 1,           -- 1=轻度串货 2=重度串货(跨省)
      handled INTEGER DEFAULT 0,         -- 0=未处理 1=已处理
      handled_at TEXT,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    )
  `);

  // 兼容升级：发货记录表增加 item_code 列（支持散件发货记录）
  try { db.exec(`ALTER TABLE shipments ADD COLUMN item_code TEXT DEFAULT ''`); } catch(e) {}
  // 兼容升级：子码表增加 shipped_at 列（记录散件发货时间）
  try { db.exec(`ALTER TABLE items ADD COLUMN shipped_at TEXT`); } catch(e) {}
  // 兼容升级：产品表增加 box_size 列（默认箱规，工厂装箱自动带出）
  try { db.exec(`ALTER TABLE products ADD COLUMN box_size INTEGER DEFAULT 0`); } catch(e) {}
  // 兼容升级：扫码日志增加经纬度列（浏览器定位，HTTPS 环境下生效，留存备查）
  try { db.exec(`ALTER TABLE scan_logs ADD COLUMN latitude REAL`); } catch(e) {}
  try { db.exec(`ALTER TABLE scan_logs ADD COLUMN longitude REAL`); } catch(e) {}
  // 兼容升级：用户表增加工厂归属列（工厂数据隔离）
  try { db.exec(`ALTER TABLE users ADD COLUMN factory_id INTEGER`); } catch(e) {}
  // 兼容升级：产品表增加工厂归属列（NULL=总部产品，仅管理员可见）
  try { db.exec(`ALTER TABLE products ADD COLUMN factory_id INTEGER`); } catch(e) {}
  // 操作留痕表（关键操作记录到数据库，便于审计）
  db.exec(`
    CREATE TABLE IF NOT EXISTS operation_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      username TEXT,
      role TEXT,
      action TEXT NOT NULL,
      target_type TEXT,
      target_id TEXT,
      detail TEXT,
      ip TEXT,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    )
  `);
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_products_factory ON products(factory_id)`); } catch(e) {}

  // 兼容升级：放宽 shipments.box_id 约束（允许 NULL，支持散件发货无箱记录）
  {
    const cols = db.prepare("PRAGMA table_info(shipments)").all();
    const boxIdCol = cols.find(c => c.name === 'box_id');
    if (boxIdCol && boxIdCol.notnull === 1) {
      db.exec(`
        CREATE TABLE shipments_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          box_id INTEGER,
          distributor_id INTEGER NOT NULL,
          item_code TEXT DEFAULT '',
          shipped_at TEXT DEFAULT (datetime('now','localtime')),
          operator TEXT DEFAULT ''
        );
        INSERT INTO shipments_new (id, box_id, distributor_id, item_code, shipped_at, operator)
          SELECT id, box_id, distributor_id, COALESCE(item_code,''), shipped_at, operator FROM shipments;
        DROP TABLE shipments;
        ALTER TABLE shipments_new RENAME TO shipments;
      `);
      console.log('[DB] shipments 表已升级（box_id 允许 NULL）');
    }
  }

  // ===================== 多品牌（SaaS 多租户）架构 =====================
  // 品牌表：平台管理员创建，每个品牌一个独立数据空间
  db.exec(`
    CREATE TABLE IF NOT EXISTS brands (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      contact TEXT DEFAULT '',
      enabled INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    )
  `);
  // 各表挂 brand_id（NULL=平台级，仅平台管理员可见）
  try { db.exec(`ALTER TABLE factories ADD COLUMN brand_id INTEGER`); } catch(e) {}
  try { db.exec(`ALTER TABLE users ADD COLUMN brand_id INTEGER`); } catch(e) {}
  try { db.exec(`ALTER TABLE products ADD COLUMN brand_id INTEGER`); } catch(e) {}
  try { db.exec(`ALTER TABLE distributors ADD COLUMN brand_id INTEGER`); } catch(e) {}
  try { db.exec(`ALTER TABLE invitations ADD COLUMN brand_id INTEGER`); } catch(e) {}
  try { db.exec(`ALTER TABLE scan_logs ADD COLUMN brand_id INTEGER`); } catch(e) {}
  try { db.exec(`ALTER TABLE alerts ADD COLUMN brand_id INTEGER`); } catch(e) {}
  try { db.exec(`ALTER TABLE operation_logs ADD COLUMN brand_id INTEGER`); } catch(e) {}

  // 存量数据迁移：创建默认品牌，把所有旧数据归入，保证升级后老功能不受影响
  {
    const bCount = db.prepare('SELECT COUNT(*) as c FROM brands').get().c;
    if (bCount === 0) {
      const r = db.prepare('INSERT INTO brands (name, contact) VALUES (?,?)').run('默认品牌', '');
      const bid = r.lastInsertRowid;
      db.prepare(`UPDATE factories SET brand_id=? WHERE brand_id IS NULL`).run(bid);
      db.prepare(`UPDATE products SET brand_id=(SELECT brand_id FROM factories WHERE id=products.factory_id) WHERE brand_id IS NULL AND factory_id IS NOT NULL`).run();
      db.prepare(`UPDATE products SET brand_id=? WHERE brand_id IS NULL`).run(bid); // 无工厂的旧产品也归默认品牌
      db.prepare(`UPDATE distributors SET brand_id=? WHERE brand_id IS NULL`).run(bid);
      db.prepare(`UPDATE users SET brand_id=(SELECT brand_id FROM factories WHERE id=users.factory_id) WHERE role='factory' AND brand_id IS NULL AND factory_id IS NOT NULL`).run();
      db.prepare(`UPDATE users SET brand_id=(SELECT brand_id FROM distributors WHERE id=users.distributor_id) WHERE role='distributor' AND brand_id IS NULL AND distributor_id IS NOT NULL`).run();
      db.prepare(`UPDATE users SET brand_id=? WHERE role IN ('warehouse') AND brand_id IS NULL`).run(bid);
      db.prepare(`UPDATE invitations SET brand_id=? WHERE brand_id IS NULL`).run(bid);
      // 扫码日志/预警按码反查品牌归档
      db.prepare(`UPDATE scan_logs SET brand_id=COALESCE(
        (SELECT p.brand_id FROM items i JOIN products p ON i.product_id=p.id WHERE i.item_code=scan_logs.item_code),
        (SELECT p.brand_id FROM boxes b JOIN products p ON b.product_id=p.id WHERE b.box_code=scan_logs.box_code)
      ) WHERE brand_id IS NULL`).run();
      db.prepare(`UPDATE scan_logs SET brand_id=? WHERE brand_id IS NULL`).run(bid);
      db.prepare(`UPDATE alerts SET brand_id=COALESCE(
        (SELECT p.brand_id FROM items i JOIN products p ON i.product_id=p.id WHERE i.item_code=alerts.item_code),
        (SELECT p.brand_id FROM boxes b JOIN products p ON b.product_id=p.id WHERE b.box_code=alerts.box_code)
      ) WHERE brand_id IS NULL`).run();
      db.prepare(`UPDATE alerts SET brand_id=? WHERE brand_id IS NULL`).run(bid);
      db.prepare(`UPDATE operation_logs SET brand_id=(SELECT brand_id FROM users WHERE id=operation_logs.user_id) WHERE brand_id IS NULL`).run();
      console.log('[DB] 已创建默认品牌，存量数据已全部归入（多品牌架构升级完成）');
    }
  }
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_products_brand ON products(brand_id)`); } catch(e) {}
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_boxes_product ON boxes(product_id)`); } catch(e) {}
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_items_product ON items(product_id)`); } catch(e) {}
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_scan_logs_brand ON scan_logs(brand_id)`); } catch(e) {}
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_alerts_brand ON alerts(brand_id)`); } catch(e) {}

  // 兼容升级：放宽 boxes/items 的 product_id 约束（允许 NULL=空白码，装箱时再绑产品）
  // 并直接挂 brand_id 列（空白码没有产品可 JOIN，品牌隔离改用自身 brand_id）
  // 注意：外键约束开着时 DROP 父表会失败，重建期间临时关闭
  {
    const boxCols = db.prepare("PRAGMA table_info(boxes)").all();
    const boxPid = boxCols.find(c => c.name === 'product_id');
    const boxHasBrand = boxCols.some(c => c.name === 'brand_id');
    if ((boxPid && boxPid.notnull === 1) || !boxHasBrand) {
      // 旧表可能还没有 brand_id 列，动态取值
      const boxBrandExpr = boxHasBrand
        ? 'COALESCE(b.brand_id, (SELECT p.brand_id FROM products p WHERE p.id = b.product_id), NULL)'
        : '(SELECT p.brand_id FROM products p WHERE p.id = b.product_id)';
      db.pragma('foreign_keys = OFF');
      db.exec(`
        CREATE TABLE boxes_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          box_code TEXT UNIQUE NOT NULL,
          product_id INTEGER,
          brand_id INTEGER,
          batch_no TEXT DEFAULT '',
          item_count INTEGER DEFAULT 0,
          status TEXT DEFAULT 'in_stock',
          distributor_id INTEGER,
          shipped_at TEXT,
          created_at TEXT DEFAULT (datetime('now','localtime'))
        );
        INSERT INTO boxes_new (id, box_code, product_id, brand_id, batch_no, item_count, status, distributor_id, shipped_at, created_at)
          SELECT b.id, b.box_code, b.product_id,
            ${boxBrandExpr},
            b.batch_no, b.item_count, b.status, b.distributor_id, b.shipped_at, b.created_at
          FROM boxes b;
        DROP TABLE boxes;
        ALTER TABLE boxes_new RENAME TO boxes;
      `);
      db.pragma('foreign_keys = ON');
      console.log('[DB] boxes 表已升级（product_id 允许 NULL，支持空白箱码）');
    }

    const itemCols = db.prepare("PRAGMA table_info(items)").all();
    const itemPid = itemCols.find(c => c.name === 'product_id');
    const itemHasBrand = itemCols.some(c => c.name === 'brand_id');
    if ((itemPid && itemPid.notnull === 1) || !itemHasBrand) {
      const itemBrandExpr = itemHasBrand
        ? 'COALESCE(i.brand_id, (SELECT p.brand_id FROM products p WHERE p.id = i.product_id), NULL)'
        : '(SELECT p.brand_id FROM products p WHERE p.id = i.product_id)';
      db.pragma('foreign_keys = OFF');
      db.exec(`
        CREATE TABLE items_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          item_code TEXT UNIQUE NOT NULL,
          box_id INTEGER,
          product_id INTEGER,
          brand_id INTEGER,
          batch_no TEXT DEFAULT '',
          status TEXT DEFAULT 'in_stock',
          distributor_id INTEGER,
          scanned_at TEXT,
          scan_location TEXT,
          scan_ip TEXT,
          shipped_at TEXT,
          created_at TEXT DEFAULT (datetime('now','localtime'))
        );
        INSERT INTO items_new (id, item_code, box_id, product_id, brand_id, batch_no, status, distributor_id, scanned_at, scan_location, scan_ip, shipped_at, created_at)
          SELECT i.id, i.item_code, i.box_id, i.product_id,
            ${itemBrandExpr},
            i.batch_no, i.status, i.distributor_id, i.scanned_at, i.scan_location, i.scan_ip, i.shipped_at, i.created_at
          FROM items i;
        DROP TABLE items;
        ALTER TABLE items_new RENAME TO items;
      `);
      db.pragma('foreign_keys = ON');
      console.log('[DB] items 表已升级（product_id 允许 NULL，支持空白子码）');
    }
  }
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_boxes_brand ON boxes(brand_id)`); } catch(e) {}
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_items_brand ON items(brand_id)`); } catch(e) {}

  // 索引
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_boxes_code ON boxes(box_code);
    CREATE INDEX IF NOT EXISTS idx_items_code ON items(item_code);
    CREATE INDEX IF NOT EXISTS idx_items_box_id ON items(box_id);
    CREATE INDEX IF NOT EXISTS idx_scan_logs_code ON scan_logs(item_code);
    CREATE INDEX IF NOT EXISTS idx_scan_logs_diversion ON scan_logs(is_diversion);
    CREATE INDEX IF NOT EXISTS idx_alerts_handled ON alerts(handled);
  `);

  // 默认品牌设置
  const defaultSettings = {
    brand_name: '正品溯源',
    logo_text: 'RC',
    welcome_msg: '正品验证 · 一扫溯源',
    theme_color: '#1a73e8',
    contact_phone: '',
    product_images: '',      // 产品图片URL，换行分隔，验证页轮播展示
    promo_video: '',         // 宣传视频URL，验证页展示
    show_scan_count: '1'     // 验证页是否展示累计扫码统计
  };
  const upsertSetting = db.prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO NOTHING');
  for (const [k, v] of Object.entries(defaultSettings)) {
    upsertSetting.run(k, v);
  }

  // 会话密钥：首次生成后持久化在 settings 表（服务重启不失效）
  {
    const row = db.prepare("SELECT value FROM settings WHERE key='session_secret'").get();
    if (!row) {
      db.prepare("INSERT INTO settings (key,value) VALUES ('session_secret',?)")
        .run(require('crypto').randomBytes(32).toString('hex'));
    }
  }

  // 初始账号：生产环境必须显式提供强密码，禁止创建可预测的示例账号。
  {
    const count = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
    if (count === 0) {
      const isProduction = process.env.NODE_ENV === 'production';
      const initialPassword = process.env.INITIAL_ADMIN_PASSWORD || (isProduction ? '' : 'admin123');
      if (isProduction && initialPassword.length < 12) {
        throw new Error('INITIAL_ADMIN_PASSWORD must be at least 12 characters for first production startup');
      }
      const insertUser = db.prepare('INSERT INTO users (username, password_hash, display_name, role, distributor_id) VALUES (?,?,?,?,?)');
      insertUser.run('admin', hashPassword(initialPassword), '总部管理员', 'admin', null);
      console.log(isProduction ? '[DB] 已创建生产管理员账号' : '[DB] 已创建本地开发管理员账号：admin/admin123');
    }
  }

  // 兼容升级：首次引入工厂体系时，创建默认工厂并把存量数据归入，保证旧功能不受影响
  {
    const fCount = db.prepare('SELECT COUNT(*) as c FROM factories').get().c;
    if (fCount === 0) {
      const r = db.prepare('INSERT INTO factories (name, contact) VALUES (?,?)').run('默认工厂', '');
      const fid = r.lastInsertRowid;
      db.prepare(`UPDATE users SET factory_id=? WHERE role='factory' AND factory_id IS NULL`).run(fid);
      db.prepare(`UPDATE products SET factory_id=? WHERE factory_id IS NULL`).run(fid);
      console.log('[DB] 已创建默认工厂，存量产品与工厂账号已归入');
    }
  }

  console.log('[DB] 数据库初始化完成');
}

// ===================== 密码哈希（scrypt） =====================

function hashPassword(password) {
  const crypto = require('crypto');
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const crypto = require('crypto');
  if (!stored || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  const calc = crypto.scryptSync(String(password), salt, 64).toString('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(calc, 'hex'));
  } catch (e) {
    return false;
  }
}

module.exports = { db, initDatabase, hashPassword, verifyPassword };
