const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const QRCode = require('qrcode');

const PORT = Number(process.env.FILEDROP_PORT || 8090);
const RECEIVED_DIR =
  process.env.FILEDROP_RECEIVED_DIR || path.join(os.homedir(), 'Downloads', 'FileDrop');
const OUTBOX_DIR = process.env.FILEDROP_OUTBOX_DIR || path.join(__dirname, 'outbox');

const PIN_TTL_MS = 10 * 60 * 1000; // unused PIN expires after 10 min
const SESSION_TTL_MS = 15 * 60 * 1000; // paired sessions expire after 15 min
const MAX_PIN_ATTEMPTS = 5;
const LOCKOUT_MS = 60 * 1000;
const MAX_FILE_BYTES = 4 * 1024 * 1024 * 1024;
const MAX_FILES_PER_UPLOAD = 25;

fs.mkdirSync(RECEIVED_DIR, { recursive: true });
fs.mkdirSync(OUTBOX_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// PIN + session state
// ---------------------------------------------------------------------------

let currentPin = null; // { code, createdAt }
const sessions = new Map(); // token -> { expiresAt, ip }
const pinAttempts = new Map(); // ip -> { count, lockedUntil }

function rotatePin(reason) {
  currentPin = {
    code: String(crypto.randomInt(0, 1000000)).padStart(6, '0'),
    createdAt: Date.now(),
  };
  console.log(`\n  PIN: ${currentPin.code}   (${reason})\n`);
  return currentPin;
}

function getPin() {
  if (!currentPin || Date.now() - currentPin.createdAt > PIN_TTL_MS) {
    rotatePin(currentPin ? 'previous PIN expired' : 'startup');
  }
  return currentPin;
}

function pinMatches(candidate) {
  const a = crypto.createHash('sha256').update(String(candidate)).digest();
  const b = crypto.createHash('sha256').update(getPin().code).digest();
  return crypto.timingSafeEqual(a, b);
}

function createSession(ip) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { expiresAt: Date.now() + SESSION_TTL_MS, ip });
  return token;
}

function getSession(req) {
  const cookies = req.headers.cookie || '';
  const match = cookies.match(/(?:^|;\s*)fd_session=([a-f0-9]{64})/);
  if (!match) return null;
  const session = sessions.get(match[1]);
  if (!session) return null;
  if (Date.now() > session.expiresAt) {
    sessions.delete(match[1]);
    return null;
  }
  return session;
}

setInterval(() => {
  const now = Date.now();
  for (const [token, s] of sessions) if (now > s.expiresAt) sessions.delete(token);
  for (const [ip, a] of pinAttempts) {
    if (a.lockedUntil && now > a.lockedUntil) pinAttempts.delete(ip);
  }
}, 60 * 1000).unref();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clientIp(req) {
  return req.socket.remoteAddress || 'unknown';
}

function isLocalhost(req) {
  return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
}

// Multer decodes originalname as latin1; recover UTF-8, then strip anything
// that could escape the target directory or confuse the filesystem.
function sanitizeName(original) {
  const utf8 = Buffer.from(original, 'latin1').toString('utf8');
  const base = path.basename(utf8).replace(/[\/\\:*?"<>|\x00-\x1f]/g, '_').trim();
  return base && base !== '.' && base !== '..' ? base : 'unnamed';
}

function uniquePath(dir, name) {
  const ext = path.extname(name);
  const stem = path.basename(name, ext);
  let candidate = name;
  for (let i = 1; fs.existsSync(path.join(dir, candidate)); i++) {
    candidate = `${stem} (${i})${ext}`;
  }
  return path.join(dir, candidate);
}

function listDir(dir) {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && !e.name.startsWith('.'))
    .map((e) => {
      const stat = fs.statSync(path.join(dir, e.name));
      return { name: e.name, size: stat.size, mtime: stat.mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);
}

function lanAddress() {
  const interfaces = os.networkInterfaces();
  for (const name of ['en0', 'en1']) {
    const hit = (interfaces[name] || []).find((a) => a.family === 'IPv4' && !a.internal);
    if (hit) return hit.address;
  }
  for (const addrs of Object.values(interfaces)) {
    const hit = addrs.find((a) => a.family === 'IPv4' && !a.internal);
    if (hit) return hit.address;
  }
  return '127.0.0.1';
}

function makeUploader(destDir) {
  return multer({
    storage: multer.diskStorage({
      destination: destDir,
      filename: (req, file, cb) => {
        cb(null, path.basename(uniquePath(destDir, sanitizeName(file.originalname))));
      },
    }),
    limits: { fileSize: MAX_FILE_BYTES, files: MAX_FILES_PER_UPLOAD },
  });
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1kb' }));
app.use(express.static(path.join(__dirname, 'public'), { index: 'index.html' }));

function requireSession(req, res, next) {
  const session = getSession(req);
  if (!session) return res.status(401).json({ error: 'not paired' });
  req.session = session;
  next();
}

function requireLocalhost(req, res, next) {
  if (!isLocalhost(req)) return res.status(403).json({ error: 'admin is localhost-only' });
  next();
}

// --- pairing ---------------------------------------------------------------

app.post('/api/pair', (req, res) => {
  const ip = clientIp(req);
  const attempts = pinAttempts.get(ip) || { count: 0, lockedUntil: 0 };

  if (attempts.lockedUntil > Date.now()) {
    const wait = Math.ceil((attempts.lockedUntil - Date.now()) / 1000);
    return res.status(429).json({ error: `too many attempts — locked for ${wait}s` });
  }

  const pin = String((req.body || {}).pin || '');
  if (/^\d{6}$/.test(pin) && pinMatches(pin)) {
    pinAttempts.delete(ip);
    rotatePin('used for pairing — new PIN required for next device');
    const token = createSession(ip);
    console.log(`  Paired: ${ip}`);
    res.setHeader(
      'Set-Cookie',
      `fd_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`
    );
    return res.json({ ok: true, expiresInSec: SESSION_TTL_MS / 1000 });
  }

  attempts.count += 1;
  if (attempts.count >= MAX_PIN_ATTEMPTS) {
    attempts.lockedUntil = Date.now() + LOCKOUT_MS;
    attempts.count = 0;
    rotatePin(`5 failed attempts from ${ip} — rotated`);
  }
  pinAttempts.set(ip, attempts);
  console.log(`  Failed PIN attempt from ${ip}`);
  return res.status(401).json({ error: 'wrong PIN' });
});

app.get('/api/session', (req, res) => {
  const session = getSession(req);
  if (!session) return res.status(401).json({ error: 'not paired' });
  res.json({ ok: true, expiresInSec: Math.floor((session.expiresAt - Date.now()) / 1000) });
});

// --- phone: send + receive ---------------------------------------------------

const receiveUpload = makeUploader(RECEIVED_DIR);

app.post('/api/upload', requireSession, receiveUpload.array('files'), (req, res) => {
  const names = (req.files || []).map((f) => f.filename);
  names.forEach((n) => console.log(`  Received: ${n} (from ${clientIp(req)})`));
  res.json({ ok: true, saved: names });
});

app.get('/api/outbox', requireSession, (req, res) => {
  res.json({ files: listDir(OUTBOX_DIR) });
});

app.get('/api/download', requireSession, (req, res) => {
  const name = path.basename(String(req.query.name || ''));
  const filePath = path.join(OUTBOX_DIR, name);
  if (!name || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    return res.status(404).json({ error: 'file not found' });
  }
  console.log(`  Sent: ${name} (to ${clientIp(req)})`);
  res.download(filePath, name);
});

// --- admin (Mac only) --------------------------------------------------------

app.get('/admin', requireLocalhost, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/api/admin/status', requireLocalhost, async (req, res) => {
  const url = `http://${lanAddress()}:${PORT}`;
  res.json({
    pin: getPin().code,
    pinAgeSec: Math.floor((Date.now() - getPin().createdAt) / 1000),
    url,
    qr: await QRCode.toDataURL(url, { margin: 1, width: 220 }),
    receivedDir: RECEIVED_DIR,
    received: listDir(RECEIVED_DIR),
    outbox: listDir(OUTBOX_DIR),
    activeSessions: sessions.size,
  });
});

app.post('/api/admin/rotate-pin', requireLocalhost, (req, res) => {
  rotatePin('rotated manually');
  res.json({ ok: true, pin: getPin().code });
});

const outboxUpload = makeUploader(OUTBOX_DIR);

app.post('/api/admin/share', requireLocalhost, outboxUpload.array('files'), (req, res) => {
  res.json({ ok: true, shared: (req.files || []).map((f) => f.filename) });
});

app.delete('/api/admin/outbox/:name', requireLocalhost, (req, res) => {
  const name = path.basename(req.params.name);
  const filePath = path.join(OUTBOX_DIR, name);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'file not found' });
  fs.unlinkSync(filePath);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------

app.listen(PORT, '0.0.0.0', () => {
  const url = `http://${lanAddress()}:${PORT}`;
  console.log('FileDrop is running');
  console.log(`  On your phone:  ${url}`);
  console.log(`  On this Mac:    http://localhost:${PORT}/admin  (PIN + QR code)`);
  console.log(`  Received files: ${RECEIVED_DIR}`);
  getPin();
});
