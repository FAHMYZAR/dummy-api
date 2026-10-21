'use strict';
// DummyAPI: 3 resource (buku, menu, event),
// masing-masing CRUD lengkap. Tanpa dependensi, cukup Node.js bawaan.
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.env.PORT || '3106', 10);
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = path.join(__dirname, 'data');
const PUBLIC_DIR = path.join(__dirname, 'public');

const RESOURCES = {
  buku: {
    label: 'PerpustakaanKu',
    searchFields: ['judul', 'penulis'],
    filters: { genre: 'genre' },
    required: ['judul', 'penulis', 'penerbit', 'tahun_terbit', 'genre', 'isbn', 'stok', 'halaman', 'sinopsis', 'gambar'],
    numbers: ['tahun_terbit', 'stok', 'halaman'],
  },
  menu: {
    label: 'KantinKu',
    searchFields: ['nama'],
    filters: { kategori: 'kategori', tersedia: 'tersedia' },
    required: ['nama', 'kategori', 'harga', 'tersedia', 'deskripsi', 'gambar'],
    numbers: ['harga', 'rating'],
  },
  event: {
    label: 'EventKu',
    searchFields: ['nama', 'penyelenggara'],
    filters: { kategori: 'kategori' },
    required: ['nama', 'deskripsi', 'kategori', 'tanggal', 'waktu', 'lokasi', 'kuota', 'terdaftar', 'penyelenggara', 'gambar'],
    numbers: ['kuota', 'terdaftar'],
  },
};

const store = {};
function loadData() {
  for (const name of Object.keys(RESOURCES)) {
    const file = path.join(DATA_DIR, name + '.json');
    store[name] = JSON.parse(fs.readFileSync(file, 'utf8'));
  }
}
function persist(name) {
  const file = path.join(DATA_DIR, name + '.json');
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(store[name], null, 2));
  fs.renameSync(tmp, file);
}
loadData();

function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  });
  res.end(body);
}
const ok = (res, data, extra) => send(res, 200, Object.assign({ success: true, data }, extra || {}));
const fail = (res, status, message) => send(res, status, { success: false, message });

// Rate limit token bucket. Tarif token: GET detail 1, GET list 2, tulis (POST/PUT/PATCH/DELETE) 10.
// Per IP dari header CF-Connecting-IP (semua trafik masuk lewat Cloudflare Tunnel, IP socket selalu localhost),
// plus pagar global biar container tidak sesak. Docs dan OPTIONS tidak dihitung.
const RL = { ipCapacity: 300, ipRefill: 5, globalCapacity: 600, globalRefill: 100 };
const rlBuckets = new Map();
const rlGlobal = { tokens: RL.globalCapacity, last: Date.now() };
function rlRefill(bucket, capacity, perSec, now) {
  const elapsed = (now - bucket.last) / 1000;
  if (elapsed > 0) {
    bucket.tokens = Math.min(capacity, bucket.tokens + elapsed * perSec);
    bucket.last = now;
  }
}
function clientIp(req) {
  return String(req.headers['cf-connecting-ip'] || (req.headers['x-forwarded-for'] || '').split(',')[0] || req.socket.remoteAddress || 'unknown').trim();
}
// Return 0 kalau request boleh lewat, atau jumlah detik tunggu kalau kena limit.
function checkRateLimit(req, cost) {
  const now = Date.now();
  const ip = clientIp(req);
  let b = rlBuckets.get(ip);
  if (!b) { b = { tokens: RL.ipCapacity, last: now, seen: now }; rlBuckets.set(ip, b); }
  b.seen = now;
  rlRefill(b, RL.ipCapacity, RL.ipRefill, now);
  rlRefill(rlGlobal, RL.globalCapacity, RL.globalRefill, now);
  const waitIp = b.tokens >= cost ? 0 : Math.ceil((cost - b.tokens) / RL.ipRefill);
  const waitGlobal = rlGlobal.tokens >= cost ? 0 : Math.ceil((cost - rlGlobal.tokens) / RL.globalRefill);
  if (waitIp || waitGlobal) return Math.max(waitIp, waitGlobal, 1);
  b.tokens -= cost;
  rlGlobal.tokens -= cost;
  return 0;
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, b] of rlBuckets) {
    rlRefill(b, RL.ipCapacity, RL.ipRefill, now);
    if (b.tokens >= RL.ipCapacity && now - b.seen > 10 * 60 * 1000) rlBuckets.delete(ip);
  }
}, 5 * 60 * 1000).unref();

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 1024 * 1024) reject(new Error('body terlalu besar'));
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { reject(new Error('body bukan JSON valid')); }
    });
    req.on('error', reject);
  });
}

// Validasi + koersi tipe sederhana: field angka harus angka, tersedia harus boolean.
function coerce(cfg, body, partial) {
  const out = {};
  for (const key of Object.keys(body)) {
    if (key === 'id') continue;
    if (!cfg.required.includes(key) && key !== 'rating') continue;
    out[key] = body[key];
  }
  for (const f of cfg.numbers || []) {
    if (out[f] !== undefined) {
      const n = Number(out[f]);
      if (Number.isNaN(n)) return { error: `field ${f} harus berupa angka` };
      out[f] = n;
    }
  }
  if (out.tersedia !== undefined && typeof out.tersedia !== 'boolean') {
    if (out.tersedia === 'true') out.tersedia = true;
    else if (out.tersedia === 'false') out.tersedia = false;
    else return { error: 'field tersedia harus boolean (true/false)' };
  }
  if (!partial) {
    const missing = cfg.required.filter((f) => out[f] === undefined || out[f] === '');
    if (missing.length) return { error: 'field wajib belum diisi: ' + missing.join(', ') };
  }
  return { value: out };
}

function handleList(req, res, name, query) {
  const cfg = RESOURCES[name];
  let rows = store[name].slice();
  const search = (query.get('search') || '').toLowerCase();
  if (search) {
    rows = rows.filter((r) => cfg.searchFields.some((f) => String(r[f] || '').toLowerCase().includes(search)));
  }
  for (const [param, field] of Object.entries(cfg.filters)) {
    const v = query.get(param);
    if (v !== null && v !== '') {
      rows = rows.filter((r) => String(r[field]).toLowerCase() === v.toLowerCase());
    }
  }
  ok(res, rows, { total: rows.length });
}

async function handleApi(req, res, parts, query) {
  if (parts.length === 1) {
    return ok(res, {
      nama: 'DummyAPI',
      apps: Object.entries(RESOURCES).map(([key, cfg]) => ({
        app: cfg.label, base_url: '/api/' + key, total_data: store[key].length,
        endpoints: ['GET /api/' + key, 'GET /api/' + key + '/:id', 'POST /api/' + key, 'PUT /api/' + key + '/:id', 'PATCH /api/' + key + '/:id', 'DELETE /api/' + key + '/:id'],
      })),
      dokumentasi: '/',
    });
  }
  const name = parts[1];
  const cfg = RESOURCES[name];
  if (!cfg) return fail(res, 404, 'resource tidak ditemukan. Pilihan: ' + Object.keys(RESOURCES).join(', '));
  const id = parts[2] !== undefined ? Number(parts[2]) : null;
  if (parts.length > 3) return fail(res, 404, 'path tidak ditemukan');

  if (req.method === 'GET' && id === null) return handleList(req, res, name, query);
  if (req.method === 'GET') {
    const row = store[name].find((r) => r.id === id);
    if (!row) return fail(res, 404, `data ${name} dengan id ${parts[2]} tidak ditemukan`);
    return ok(res, row);
  }
  if (req.method === 'POST' && id === null) {
    let body;
    try { body = await readBody(req); } catch (e) { return fail(res, 400, e.message); }
    const v = coerce(cfg, body, false);
    if (v.error) return fail(res, 400, v.error);
    const nextId = store[name].reduce((m, r) => Math.max(m, r.id), 0) + 1;
    const row = Object.assign({ id: nextId }, v.value);
    store[name].push(row);
    persist(name);
    return send(res, 201, { success: true, message: 'data berhasil ditambahkan', data: row });
  }
  if ((req.method === 'PUT' || req.method === 'PATCH') && id !== null) {
    const idx = store[name].findIndex((r) => r.id === id);
    if (idx < 0) return fail(res, 404, `data ${name} dengan id ${parts[2]} tidak ditemukan`);
    let body;
    try { body = await readBody(req); } catch (e) { return fail(res, 400, e.message); }
    const v = coerce(cfg, body, true);
    if (v.error) return fail(res, 400, v.error);
    store[name][idx] = Object.assign({}, store[name][idx], v.value);
    persist(name);
    return ok(res, store[name][idx], { message: 'data berhasil diperbarui' });
  }
  if (req.method === 'DELETE' && id !== null) {
    const idx = store[name].findIndex((r) => r.id === id);
    if (idx < 0) return fail(res, 404, `data ${name} dengan id ${parts[2]} tidak ditemukan`);
    const removed = store[name].splice(idx, 1)[0];
    persist(name);
    return ok(res, removed, { message: 'data berhasil dihapus' });
  }
  return fail(res, 405, 'method tidak didukung untuk path ini');
}

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
function serveStatic(req, res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const file = path.join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    return fail(res, 404, 'halaman tidak ditemukan');
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://localhost');
    if (req.method === 'OPTIONS') return send(res, 204, {});
    const parts = u.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    if (parts[0] === 'api') {
      const cost = req.method === 'GET' ? (parts.length >= 3 ? 1 : parts.length === 2 ? 2 : 1) : 10;
      const retry = checkRateLimit(req, cost);
      if (retry > 0) {
        res.writeHead(429, {
          'Content-Type': 'application/json; charset=utf-8',
          'Access-Control-Allow-Origin': '*',
          'Retry-After': String(retry),
        });
        return res.end(JSON.stringify({ success: false, message: 'Terlalu banyak request. Tunggu sebentar, lalu coba lagi.' }));
      }
      return await handleApi(req, res, parts, u.searchParams);
    }
    if (req.method === 'GET') return serveStatic(req, res, u.pathname);
    return fail(res, 404, 'path tidak ditemukan');
  } catch (e) {
    return fail(res, 500, 'kesalahan server: ' + e.message);
  }
});

server.listen(PORT, HOST, () => console.log(`gawai-api listening on ${HOST}:${PORT}`));
