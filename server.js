'use strict';
/* Gateway Restaurant backend. No npm packages needed: Node 22.13+ only. */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = Number(process.env.PORT) || 3000;
const DATA = process.env.DATA_DIR || path.join(__dirname, 'data');
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const PUBLIC = __dirname;
fs.mkdirSync(path.join(DATA, 'receipts'), { recursive: true });

/* ---------- database ---------- */
const db = new DatabaseSync(path.join(DATA, 'gateway.db'));
db.exec(`
PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS restaurants(
  id TEXT PRIMARY KEY, name TEXT NOT NULL, area TEXT NOT NULL DEFAULT '', tags TEXT NOT NULL DEFAULT '[]',
  time TEXT NOT NULL DEFAULT '25-35', rating REAL NOT NULL DEFAULT 4.5, c1 TEXT NOT NULL DEFAULT '#0E5A4B', c2 TEXT NOT NULL DEFAULT '#093A30',
  open INTEGER NOT NULL DEFAULT 1, bank_name TEXT NOT NULL DEFAULT '', acct_name TEXT NOT NULL DEFAULT '', acct_no TEXT NOT NULL DEFAULT '',
  salt TEXT NOT NULL, pass_hash TEXT NOT NULL, created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS menu_items(
  id INTEGER PRIMARY KEY AUTOINCREMENT, rid TEXT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  name TEXT NOT NULL, price INTEGER NOT NULL, cat TEXT NOT NULL DEFAULT 'Other', descr TEXT NOT NULL DEFAULT '', avail INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS orders(
  code TEXT PRIMARY KEY, rid TEXT NOT NULL, rname TEXT NOT NULL, items TEXT NOT NULL,
  food INTEGER, delivery INTEGER, pack INTEGER, service INTEGER, total INTEGER,
  name TEXT, phone TEXT, mode TEXT, zone TEXT, addr TEXT, note TEXT, pay TEXT,
  receipt_ext TEXT, status TEXT NOT NULL, created INTEGER NOT NULL, times TEXT NOT NULL DEFAULT '{}');
CREATE INDEX IF NOT EXISTS orders_rid ON orders(rid, created);
CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY, rid TEXT NOT NULL, expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS settings(k TEXT PRIMARY KEY, v TEXT NOT NULL);
`);
try { db.exec("ALTER TABLE restaurants ADD COLUMN fees TEXT NOT NULL DEFAULT '{}'"); } catch (e) { /* column already exists */ }
const DEFAULT_CONFIG = {
  zones: { 'Kuto': 500, 'Oke-Ilewo': 500, 'Panseke': 500, 'Idi-Aba': 500, 'Isale-Igbein': 600, 'Lafenwa': 700, 'Ibara': 700, 'Adatan': 800, 'Sapon': 800, 'Lantoro': 900, 'FUNAAB': 1000 },
  packPerItem: 50, service: 150,
};
const getConfig = () => { const r = db.prepare("SELECT v FROM settings WHERE k='config'").get(); return r ? JSON.parse(r.v) : DEFAULT_CONFIG; };
const setConfig = c => db.prepare("INSERT INTO settings(k,v) VALUES('config',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").run(JSON.stringify(c));

/* ---------- helpers ---------- */
const now = () => Date.now();
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 32).toString('hex');
const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const digits = s => String(s || '').replace(/\D/g, '');
const str = (v, max) => String(v ?? '').trim().slice(0, max);
class HttpError extends Error { constructor(code, msg) { super(msg); this.code = code; } }
const bad = (msg, code = 400) => { throw new HttpError(code, msg); };

const hits = new Map();
function limit(key, max, windowMs) {
  const t = now(), arr = (hits.get(key) || []).filter(x => t - x < windowMs);
  if (arr.length >= max) bad('Too many attempts. Please wait a few minutes and try again.', 429);
  arr.push(t); hits.set(key, arr);
}
setInterval(() => { const t = now(); for (const [k, v] of hits) if (!v.some(x => t - x < 3600e3)) hits.delete(k); db.prepare('DELETE FROM sessions WHERE expires<?').run(t); }, 600e3).unref();
const ipOf = req => (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'x';

const publicRestaurant = r => ({
  id: r.id, name: r.name, area: r.area, tags: JSON.parse(r.tags), time: r.time, rating: r.rating, c1: r.c1, c2: r.c2, open: !!r.open, fees: JSON.parse(r.fees || '{}'),
  bank: { bankName: r.bank_name, acctName: r.acct_name, acctNo: r.acct_no },
  menu: db.prepare('SELECT id,name,price,cat,descr AS "desc",avail FROM menu_items WHERE rid=? ORDER BY id').all(r.id).map(m => ({ ...m, id: String(m.id), avail: !!m.avail })),
});
const orderView = o => ({
  code: o.code, rid: o.rid, rname: o.rname, items: JSON.parse(o.items), food: o.food, delivery: o.delivery, pack: o.pack, service: o.service, total: o.total,
  name: o.name, phone: o.phone, mode: o.mode, zone: o.zone, addr: o.addr, note: o.note, pay: o.pay, hasReceipt: !!o.receipt_ext,
  status: o.status, created: o.created, times: JSON.parse(o.times),
});
const slug = name => { const base = str(name, 40).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'restaurant'; let id = base, n = 2; while (db.prepare('SELECT 1 FROM restaurants WHERE id=?').get(id)) id = base + '-' + n++; return id; };
const PALETTE = [['#0E5A4B', '#093A30'], ['#C2410C', '#7C2A08'], ['#7A3B12', '#3E1B06'], ['#B87400', '#6E4500'], ['#2B5D9E', '#173866'], ['#6A4C93', '#3D2A60']];

/* ---------- auth ---------- */
function vendorAuth(req) {
  const m = /^Bearer (\w{20,})$/.exec(req.headers.authorization || '');
  if (!m) bad('Please log in again.', 401);
  const s = db.prepare('SELECT rid FROM sessions WHERE token_hash=? AND expires>?').get(sha(m[1]), now());
  if (!s) bad('Your session has ended. Please log in again.', 401);
  const r = db.prepare('SELECT * FROM restaurants WHERE id=?').get(s.rid);
  if (!r) bad('Restaurant not found.', 401);
  return r;
}
function adminAuth(req) {
  if (ADMIN_KEY.length < 8) bad('Admin is switched off. Set ADMIN_KEY (at least 8 characters) on the server.', 503);
  limit('admin:' + ipOf(req), 30, 15 * 60e3);
  if (!safeEq(req.headers['x-admin-key'] || '', ADMIN_KEY)) bad('Wrong admin key.', 401);
}

/* ---------- receipts ---------- */
function saveReceipt(code, dataUrl) {
  const m = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!m) bad('The receipt must be a JPG, PNG or WEBP image.');
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 600 * 1024) bad('The receipt image is too big.');
  const sig = buf.subarray(0, 4).toString('hex');
  const ext = sig.startsWith('ffd8ff') ? 'jpg' : sig === '89504e47' ? 'png' : (buf.subarray(0, 4).toString() === 'RIFF' && buf.subarray(8, 12).toString() === 'WEBP') ? 'webp' : null;
  if (!ext) bad('That file is not a real image.');
  fs.writeFileSync(path.join(DATA, 'receipts', code + '.' + ext), buf);
  return ext;
}
const MIME = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

/* ---------- routes ---------- */
const routes = [];
const route = (method, pattern, fn) => routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), fn });

route('GET', '/api/health', () => ({ ok: true }));
route('GET', '/api/config', () => getConfig());
route('GET', '/api/restaurants', () => db.prepare('SELECT * FROM restaurants ORDER BY created').all().map(publicRestaurant));

route('POST', '/api/orders', ({ body, req }) => {
  limit('order:' + ipOf(req), 12, 60 * 60e3);
  const cfg = getConfig();
  const r = db.prepare('SELECT * FROM restaurants WHERE id=?').get(str(body.rid, 80));
  if (!r) bad('Restaurant not found.');
  if (!r.open) bad('This restaurant is closed right now.');
  if (!Array.isArray(body.items) || !body.items.length || body.items.length > 40) bad('Your cart is empty.');
  const lines = []; let food = 0, count = 0;
  for (const it of body.items) {
    const q = Number(it.q), m = db.prepare('SELECT * FROM menu_items WHERE id=? AND rid=?').get(Number(it.id), r.id);
    if (!m || !Number.isInteger(q) || q < 1 || q > 50) bad('Something in your cart is no longer on the menu.');
    if (!m.avail) bad(m.name + ' is sold out. Remove it and try again.');
    lines.push({ n: m.name, p: m.price, q }); food += m.price * q; count += q;
  }
  const mode = body.mode === 'pickup' ? 'pickup' : 'delivery', pay = body.pay === 'cash' ? 'cash' : 'transfer';
  const name = str(body.name, 80), phone = str(body.phone, 20), zone = str(body.zone, 40), addr = str(body.addr, 300), note = str(body.note, 300);
  if (!name) bad('Enter your name.');
  if (digits(phone).length < 10 || digits(phone).length > 15) bad('Enter a valid phone number.');
  if (mode === 'delivery') { if (!(zone in cfg.zones)) bad('Choose your area.'); if (addr.length < 5) bad('Enter your house address or a landmark.'); }
  const rf = JSON.parse(r.fees || '{}'), delivery = mode === 'pickup' ? 0 : (Number.isInteger(rf[zone]) ? rf[zone] : cfg.zones[zone]), pack = cfg.packPerItem * count, service = cfg.service, total = food + delivery + pack + service;
  let code = '', tries = 0; const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  do { code = 'GW-' + Array.from({ length: tries > 8 ? 5 : 4 }, () => A[crypto.randomInt(A.length)]).join(''); tries++; } while (db.prepare('SELECT 1 FROM orders WHERE code=?').get(code) && tries < 30);
  let ext = '';
  if (pay === 'transfer') { if (!body.receipt) bad('Upload your transfer receipt, or choose Pay on delivery.'); ext = saveReceipt(code, body.receipt); }
  db.prepare(`INSERT INTO orders(code,rid,rname,items,food,delivery,pack,service,total,name,phone,mode,zone,addr,note,pay,receipt_ext,status,created)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'received',?)`)
    .run(code, r.id, r.name, JSON.stringify(lines), food, delivery, pack, service, total, name, phone, mode, mode === 'delivery' ? zone : '', mode === 'delivery' ? addr : '', note, pay, ext, now());
  return orderView(db.prepare('SELECT * FROM orders WHERE code=?').get(code));
});

route('POST', '/api/orders/track', ({ body, req }) => {
  limit('track:' + ipOf(req), 30, 10 * 60e3);
  const o = db.prepare('SELECT * FROM orders WHERE code=?').get(str(body.code, 12).toUpperCase());
  if (!o || digits(o.phone) !== digits(body.phone)) bad('We could not find that order. Check the code and phone number.', 404);
  return orderView(o);
});

route('POST', '/api/vendor/login', ({ body, req }) => {
  const rid = str(body.rid, 80);
  limit('login:' + ipOf(req) + ':' + rid, 10, 15 * 60e3);
  const r = db.prepare('SELECT * FROM restaurants WHERE id=?').get(rid);
  if (!r || !safeEq(hashPw(String(body.password || ''), r.salt), r.pass_hash)) bad('Wrong restaurant or password.', 401);
  const token = crypto.randomBytes(24).toString('hex');
  db.prepare('INSERT INTO sessions(token_hash,rid,expires) VALUES(?,?,?)').run(sha(token), r.id, now() + 7 * 864e5);
  return { token, rid: r.id };
});
route('POST', '/api/vendor/logout', ({ req }) => {
  const m = /^Bearer (\w+)$/.exec(req.headers.authorization || ''); if (m) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(sha(m[1])); return { ok: true };
});
route('GET', '/api/vendor/orders', ({ req }) => {
  const r = vendorAuth(req);
  return db.prepare('SELECT * FROM orders WHERE rid=? ORDER BY created DESC LIMIT 300').all(r.id).map(orderView);
});
route('GET', '/api/vendor/orders/:code/receipt', ({ req, params, res }) => {
  const r = vendorAuth(req), o = db.prepare('SELECT * FROM orders WHERE code=? AND rid=?').get(params.code, r.id);
  if (!o || !o.receipt_ext) bad('No receipt for this order.', 404);
  const file = path.join(DATA, 'receipts', o.code + '.' + o.receipt_ext);
  if (!fs.existsSync(file)) bad('Receipt file missing.', 404);
  res.writeHead(200, { 'Content-Type': MIME[o.receipt_ext], 'Cache-Control': 'private, max-age=3600' });
  res.end(fs.readFileSync(file)); return null;
});
const NEXT = { received: ['accepted', 'rejected'], accepted: ['ready'], ready: ['delivered'] };
route('POST', '/api/vendor/orders/:code/status', ({ req, params, body }) => {
  const r = vendorAuth(req), o = db.prepare('SELECT * FROM orders WHERE code=? AND rid=?').get(params.code, r.id);
  if (!o) bad('Order not found.', 404);
  if (!(NEXT[o.status] || []).includes(body.status)) bad('This order cannot move to that step.');
  const times = JSON.parse(o.times); times[body.status] = now();
  db.prepare('UPDATE orders SET status=?, times=? WHERE code=?').run(body.status, JSON.stringify(times), o.code);
  return orderView(db.prepare('SELECT * FROM orders WHERE code=?').get(o.code));
});
route('GET', '/api/vendor/me', ({ req }) => publicRestaurant(vendorAuth(req)));
route('PUT', '/api/vendor/settings', ({ req, body }) => {
  const r = vendorAuth(req);
  if (typeof body.open === 'boolean') db.prepare('UPDATE restaurants SET open=? WHERE id=?').run(body.open ? 1 : 0, r.id);
  if ('bankName' in body || 'acctName' in body || 'acctNo' in body)
    db.prepare('UPDATE restaurants SET bank_name=?,acct_name=?,acct_no=? WHERE id=?').run(str(body.bankName, 60), str(body.acctName, 80), digits(body.acctNo).slice(0, 20), r.id);
  if (body.password) {
    if (String(body.password).length < 6) bad('Password must be at least 6 characters.');
    const salt = crypto.randomBytes(16).toString('hex');
    db.prepare('UPDATE restaurants SET salt=?, pass_hash=? WHERE id=?').run(salt, hashPw(String(body.password), salt), r.id);
  }
  return publicRestaurant(db.prepare('SELECT * FROM restaurants WHERE id=?').get(r.id));
});
function itemFields(body, partial) {
  const o = {};
  if (!partial || 'name' in body) { o.name = str(body.name, 80); if (!o.name) bad('Enter a dish name.'); }
  if (!partial || 'price' in body) { o.price = Number(body.price); if (!Number.isInteger(o.price) || o.price < 0 || o.price > 1e7) bad('Enter a valid price.'); }
  if (!partial || 'cat' in body) o.cat = str(body.cat, 40) || 'Other';
  if (!partial || 'desc' in body) o.descr = str(body.desc, 160);
  if ('avail' in body) o.avail = body.avail ? 1 : 0;
  return o;
}
route('POST', '/api/vendor/menu', ({ req, body }) => {
  const r = vendorAuth(req), f = itemFields(body, false);
  db.prepare('INSERT INTO menu_items(rid,name,price,cat,descr,avail) VALUES(?,?,?,?,?,1)').run(r.id, f.name, f.price, f.cat, f.descr);
  return publicRestaurant(r).menu;
});
route('PUT', '/api/vendor/menu/:id', ({ req, params, body }) => {
  const r = vendorAuth(req), m = db.prepare('SELECT id FROM menu_items WHERE id=? AND rid=?').get(Number(params.id), r.id);
  if (!m) bad('Dish not found.', 404);
  const f = itemFields(body, true), keys = Object.keys(f);
  if (keys.length) db.prepare(`UPDATE menu_items SET ${keys.map(k => k + '=?').join(',')} WHERE id=?`).run(...keys.map(k => f[k]), m.id);
  return publicRestaurant(r).menu;
});
route('DELETE', '/api/vendor/menu/:id', ({ req, params }) => {
  const r = vendorAuth(req); db.prepare('DELETE FROM menu_items WHERE id=? AND rid=?').run(Number(params.id), r.id); return publicRestaurant(r).menu;
});

/* admin: add restaurants and reset passwords */
route('GET', '/api/admin/restaurants', ({ req }) => { adminAuth(req); return db.prepare('SELECT * FROM restaurants ORDER BY created').all().map(r => ({ ...publicRestaurant(r), menu: undefined, orders: db.prepare('SELECT COUNT(*) n FROM orders WHERE rid=?').get(r.id).n })); });
route('POST', '/api/admin/restaurants', ({ req, body }) => {
  adminAuth(req);
  const name = str(body.name, 60); if (!name) bad('Enter the restaurant name.');
  if (String(body.password || '').length < 6) bad('Password must be at least 6 characters.');
  const id = slug(name), salt = crypto.randomBytes(16).toString('hex'), n = db.prepare('SELECT COUNT(*) n FROM restaurants').get().n, [c1, c2] = PALETTE[n % PALETTE.length];
  const tags = (Array.isArray(body.tags) ? body.tags : String(body.tags || '').split(',')).map(t => str(t, 30)).filter(Boolean);
  db.prepare('INSERT INTO restaurants(id,name,area,tags,time,rating,c1,c2,open,bank_name,acct_name,acct_no,salt,pass_hash,created) VALUES(?,?,?,?,?,?,?,?,1,?,?,?,?,?,?)')
    .run(id, name, str(body.area, 40), JSON.stringify(tags), str(body.time, 12) || '25-35', Number(body.rating) || 4.5, c1, c2, str(body.bankName, 60), str(body.acctName, 80), digits(body.acctNo).slice(0, 20), salt, hashPw(String(body.password), salt), now());
  return { id };
});
route('PUT', '/api/admin/restaurants/:id', ({ req, params, body }) => {
  adminAuth(req);
  const r = db.prepare('SELECT * FROM restaurants WHERE id=?').get(params.id); if (!r) bad('Restaurant not found.', 404);
  if (body.password) { if (String(body.password).length < 6) bad('Password must be at least 6 characters.'); const salt = crypto.randomBytes(16).toString('hex'); db.prepare('UPDATE restaurants SET salt=?,pass_hash=? WHERE id=?').run(salt, hashPw(String(body.password), salt), r.id); db.prepare('DELETE FROM sessions WHERE rid=?').run(r.id); }
  if (body.name) db.prepare('UPDATE restaurants SET name=? WHERE id=?').run(str(body.name, 60), r.id);
  if ('area' in body) db.prepare('UPDATE restaurants SET area=? WHERE id=?').run(str(body.area, 40), r.id);
  if ('tags' in body) db.prepare('UPDATE restaurants SET tags=? WHERE id=?').run(JSON.stringify((Array.isArray(body.tags) ? body.tags : String(body.tags).split(',')).map(t => str(t, 30)).filter(Boolean)), r.id);
  if ('time' in body) db.prepare('UPDATE restaurants SET time=? WHERE id=?').run(str(body.time, 12), r.id);
  if ('fees' in body) {
    const cfg = getConfig(), fees = {};
    for (const [k, v] of Object.entries(body.fees || {})) {
      if (v === '' || v === null) continue;
      const n = Number(v);
      if (!(k in cfg.zones) || !Number.isInteger(n) || n < 0 || n > 100000) bad('Each delivery fee must be a whole number for a known area (' + k + ').');
      fees[k] = n;
    }
    db.prepare('UPDATE restaurants SET fees=? WHERE id=?').run(JSON.stringify(fees), r.id);
  }
  return { ok: true };
});
route('DELETE', '/api/admin/restaurants/:id', ({ req, params }) => { adminAuth(req); db.prepare('DELETE FROM restaurants WHERE id=?').run(params.id); db.prepare('DELETE FROM sessions WHERE rid=?').run(params.id); return { ok: true }; });
route('GET', '/api/admin/config', ({ req }) => { adminAuth(req); return getConfig(); });
route('PUT', '/api/admin/config', ({ req, body }) => {
  adminAuth(req);
  const z = body.zones || {}, zones = {};
  for (const [k, v] of Object.entries(z)) { const n = Number(v); if (!k || !Number.isInteger(n) || n < 0) bad('Each area needs a whole-number delivery fee.'); zones[str(k, 40)] = n; }
  if (!Object.keys(zones).length) bad('Add at least one delivery area.');
  const cfg = { zones, packPerItem: Math.max(0, parseInt(body.packPerItem, 10) || 0), service: Math.max(0, parseInt(body.service, 10) || 0) };
  setConfig(cfg); return cfg;
});

/* ---------- server ---------- */
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };
const SEC = {
  'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: blob:; script-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'",
};
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > 1.2e6) { reject(new HttpError(413, 'That upload is too large.')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}); } catch (e) { reject(new HttpError(400, 'Invalid request.')); } });
    req.on('error', reject);
  });
}
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x'), p = url.pathname;
  const send = (code, obj, extra) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...SEC, ...extra }); res.end(JSON.stringify(obj)); };
  try {
    if (p.startsWith('/api/')) {
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = r.re.exec(p); if (!m) continue;
        const body = ['POST', 'PUT'].includes(req.method) ? await readBody(req) : {};
        res.setHeader('Cache-Control', 'no-store'); for (const k in SEC) res.setHeader(k, SEC[k]);
        const out = r.fn({ req, res, body, params: m.groups || {} });
        if (out !== null) send(200, out);
        return;
      }
      return send(404, { error: 'Not found.' });
    }
    let f = p === '/' ? '/index.html' : p === '/admin' ? '/admin.html' : p;
    const file = path.normalize(path.join(PUBLIC, f));
    if (!file.startsWith(PUBLIC + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404, SEC); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache', ...SEC });
    fs.createReadStream(file).pipe(res);
  } catch (e) {
    if (e instanceof HttpError) return send(e.code, { error: e.message });
    console.error(e); send(500, { error: 'Something went wrong on our side. Please try again.' });
  }
});
if (require.main === module) server.listen(PORT, () => console.log(`Gateway Restaurant running on port ${PORT}`));
module.exports = { db, hashPw, slug, server, PALETTE };
