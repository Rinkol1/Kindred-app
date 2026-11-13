'use strict';
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');
const scrypt = promisify(crypto.scrypt);

const PORT = process.env.PORT || 3000;
const DEMO = process.env.DEMO_MODE !== '0'; // demo profiles like you back and reply to chats
const DB_FILE = path.join(__dirname, 'data', 'db.json');
const SESSION_MS = 7 * 24 * 60 * 60 * 1000;

/* ---------- Tiny JSON "database" (swap for PostgreSQL or MongoDB in production) ---------- */
fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
let db = { users: [], swipes: [], blocks: [], messages: [], sessions: {} };
if (fs.existsSync(DB_FILE)) db = { ...db, ...JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) };
const save = () => {
  fs.writeFileSync(DB_FILE + '.tmp', JSON.stringify(db, null, 2));
  fs.renameSync(DB_FILE + '.tmp', DB_FILE);
};
const uid = () => crypto.randomUUID();

/* ---------- Passwords and sessions ---------- */
async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(pw, salt, 64);
  return salt.toString('hex') + ':' + key.toString('hex');
}
async function verifyPassword(pw, stored) {
  if (!stored.includes(':')) return false;
  const [salt, key] = stored.split(':');
  const test = await scrypt(pw, Buffer.from(salt, 'hex'), 64);
  return crypto.timingSafeEqual(test, Buffer.from(key, 'hex'));
}
const DUMMY_HASH = hashPassword('not-a-real-password'); // keeps login timing the same for unknown emails
const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');

function startSession(res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  db.sessions[sha(token)] = { userId, expires: Date.now() + SESSION_MS };
  save();
  res.cookie('sid', token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: SESSION_MS,
  });
}
function readCookie(req, name) {
  const hit = (req.headers.cookie || '').split(';').map((s) => s.trim()).find((s) => s.startsWith(name + '='));
  return hit ? decodeURIComponent(hit.slice(name.length + 1)) : null;
}
function auth(req, res, next) {
  const token = readCookie(req, 'sid');
  const s = token && db.sessions[sha(token)];
  const user = s && s.expires > Date.now() && db.users.find((u) => u.id === s.userId);
  if (!user) return res.status(401).json({ error: 'Please log in.' });
  req.user = user;
  req.sessionKey = sha(token);
  next();
}

/* ---------- Small helpers ---------- */
const hits = new Map();
const limit = (max, windowMs) => (req, res, next) => {
  const key = req.ip + req.path, now = Date.now();
  const recent = (hits.get(key) || []).filter((t) => now - t < windowMs);
  if (recent.length >= max) return res.status(429).json({ error: 'Too many attempts. Try again later.' });
  recent.push(now);
  hits.set(key, recent);
  next();
};

function validateProfile(b) {
  const errors = [];
  const name = String(b.name ?? '').trim();
  const city = String(b.city ?? '').trim();
  const bio = String(b.bio ?? '').trim();
  const age = Number.parseInt(b.age, 10);
  let interests = Array.isArray(b.interests) ? b.interests : String(b.interests ?? '').split(',');
  interests = [...new Set(interests.map((s) => String(s).trim()).filter(Boolean))];
  if (name.length < 2 || name.length > 40) errors.push('Name must be 2 to 40 characters.');
  if (!(age >= 18 && age <= 99)) errors.push('You must be 18 or older to join.');
  if (city.length < 2 || city.length > 60) errors.push('City must be 2 to 60 characters.');
  if (bio.length > 300) errors.push('Bio can be up to 300 characters.');
  if (interests.length > 6 || interests.some((i) => i.length > 24)) errors.push('Add up to 6 interests, 24 characters each.');
  return { errors, value: { name, age, city, bio, interests } };
}
const publicUser = (u) => ({ id: u.id, name: u.name, age: u.age, city: u.city, bio: u.bio, interests: u.interests });
const selfUser = (u) => ({ ...publicUser(u), email: u.email });

const blockedWith = (id) =>
  new Set(db.blocks.filter((b) => b.by === id || b.target === id).map((b) => (b.by === id ? b.target : b.by)));
const liked = (a, b) => db.swipes.some((s) => s.from === a && s.to === b && s.like);
const isMatch = (a, b) => liked(a, b) && liked(b, a) && !blockedWith(a).has(b);
const thread = (a, b) =>
  db.messages.filter((m) => (m.from === a && m.to === b) || (m.from === b && m.to === a)).sort((x, y) => x.at - y.at);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const REPLIES = ['Hey! Good to meet you.', 'Ha, I like that. Tell me more.', 'What does your perfect weekend look like?', 'Same here! Coffee this week?', 'That made my day.'];

/* ---------- Demo profiles so a brand-new install has people to meet ---------- */
if (db.users.length === 0 && process.env.SEED !== '0') {
  [
    ['Amara', 27, 'Nairobi', 'Photographer who plans trips around sunrise spots.', ['Photography', 'Hiking', 'Cooking']],
    ['Daniel', 30, 'Mombasa', 'Marine biologist. Happiest on a boat.', ['Diving', 'Quiz nights', 'Jazz']],
    ['Wanjiru', 26, 'Nakuru', 'Product designer and amateur potter.', ['Pottery', 'Design', 'Podcasts']],
    ['Kofi', 29, 'Accra', 'Runs a small coffee roastery.', ['Coffee', 'Running', 'Football']],
    ['Zawadi', 28, 'Kisumu', 'Teacher by day, open-mic poet by night.', ['Poetry', 'Dogs', 'Live music']],
  ].forEach(([name, age, city, bio, interests], i) =>
    db.users.push({ id: uid(), email: `demo${i}@example.invalid`, passwordHash: '!', demo: true, name, age, city, bio, interests, createdAt: Date.now() + i }));
  save();
}

/* ---------- App ---------- */
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '20kb' }));
app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'self'; frame-ancestors 'none'",
    'Referrer-Policy': 'no-referrer',
  });
  next();
});
app.use(express.static(path.join(__dirname, 'public')));

/* --- Accounts --- */
app.post('/api/signup', limit(10, 15 * 60 * 1000), async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const { errors, value } = validateProfile(req.body);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 120) errors.push('Enter a valid email address.');
  if (password.length < 8 || password.length > 200) errors.push('Password must be at least 8 characters.');
  if (errors.length) return res.status(400).json({ error: errors.join(' ') });

  const passwordHash = await hashPassword(password);
  if (db.users.some((u) => u.email === email)) return res.status(409).json({ error: 'That email is already registered. Log in instead.' });
  const user = { id: uid(), email, passwordHash, ...value, createdAt: Date.now() };
  db.users.push(user);
  startSession(res, user.id);
  res.status(201).json(selfUser(user));
});

app.post('/api/login', limit(10, 15 * 60 * 1000), async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const user = db.users.find((u) => u.email === email);
  const ok = await verifyPassword(String(req.body.password || ''), user ? user.passwordHash : await DUMMY_HASH);
  if (!user || !ok) return res.status(401).json({ error: 'Email or password is incorrect.' });
  startSession(res, user.id);
  res.json(selfUser(user));
});

app.post('/api/logout', auth, (req, res) => {
  delete db.sessions[req.sessionKey];
  save();
  res.clearCookie('sid');
  res.json({ ok: true });
});

/* --- Profile: view, edit, delete --- */
app.get('/api/me', auth, (req, res) => res.json(selfUser(req.user)));

app.put('/api/me', auth, (req, res) => {
  const { errors, value } = validateProfile({ ...req.user, ...req.body });
  if (errors.length) return res.status(400).json({ error: errors.join(' ') });
  Object.assign(req.user, value);
  save();
  res.json(selfUser(req.user));
});

app.delete('/api/me', auth, (req, res) => {
  const id = req.user.id;
  db.users = db.users.filter((u) => u.id !== id);
  db.swipes = db.swipes.filter((s) => s.from !== id && s.to !== id);
  db.blocks = db.blocks.filter((b) => b.by !== id && b.target !== id);
  db.messages = db.messages.filter((m) => m.from !== id && m.to !== id);
  for (const k of Object.keys(db.sessions)) if (db.sessions[k].userId === id) delete db.sessions[k];
  save();
  res.clearCookie('sid');
  res.json({ ok: true });
});

/* --- Discover and matching --- */
app.get('/api/discover', auth, (req, res) => {
  const me = req.user.id;
  const seen = new Set(db.swipes.filter((s) => s.from === me).map((s) => s.to));
  const blocked = blockedWith(me);
  res.json(db.users.filter((u) => u.id !== me && !seen.has(u.id) && !blocked.has(u.id)).slice(0, 20).map(publicUser));
});

app.post('/api/swipe', auth, (req, res) => {
  const me = req.user.id;
  const like = req.body.like === true;
  const target = db.users.find((u) => u.id === req.body.targetId);
  if (!target || target.id === me || blockedWith(me).has(target.id)) return res.status(404).json({ error: 'Profile not found.' });
  if (db.swipes.some((s) => s.from === me && s.to === target.id)) return res.status(409).json({ error: 'You already responded to this profile.' });

  db.swipes.push({ from: me, to: target.id, like, at: Date.now() });
  if (like && DEMO && target.demo) db.swipes.push({ from: target.id, to: me, like: true, at: Date.now() });
  const match = like && liked(target.id, me);
  save();
  res.json({ match });
});

app.get('/api/matches', auth, (req, res) => {
  const me = req.user.id;
  const list = db.users
    .filter((u) => u.id !== me && isMatch(me, u.id))
    .map((u) => {
      const last = thread(me, u.id).pop();
      return { ...publicUser(u), lastMessage: last ? last.text : null, lastAt: last ? last.at : 0 };
    })
    .sort((a, b) => b.lastAt - a.lastAt);
  res.json(list);
});

app.post('/api/block/:id', auth, (req, res) => {
  const me = req.user.id, target = req.params.id;
  if (!db.users.some((u) => u.id === target) || target === me) return res.status(404).json({ error: 'Profile not found.' });
  if (!db.blocks.some((b) => b.by === me && b.target === target)) db.blocks.push({ by: me, target, at: Date.now() });
  save();
  res.json({ ok: true });
});

/* --- Messages (only between matches) --- */
function matchedUser(req, res) {
  const other = db.users.find((u) => u.id === req.params.id);
  if (!other || !isMatch(req.user.id, other.id)) {
    res.status(403).json({ error: 'You can only message your matches.' });
    return null;
  }
  return other;
}
app.get('/api/messages/:id', auth, (req, res) => {
  const other = matchedUser(req, res);
  if (other) res.json(thread(req.user.id, other.id).map((m) => ({ from: m.from === req.user.id ? 'me' : 'them', text: m.text, at: m.at })));
});

app.post('/api/messages/:id', auth, limit(60, 60 * 1000), (req, res) => {
  const other = matchedUser(req, res);
  if (!other) return;
  const text = String(req.body.text ?? '').trim();
  if (!text || text.length > 500) return res.status(400).json({ error: 'Messages must be 1 to 500 characters.' });
  const me = req.user.id;
  db.messages.push({ id: uid(), from: me, to: other.id, text, at: Date.now() });
  save();
  if (DEMO && other.demo) {
    setTimeout(() => {
      if (!db.users.some((u) => u.id === me)) return;
      db.messages.push({ id: uid(), from: other.id, to: me, text: pick(REPLIES), at: Date.now() });
      save();
    }, 1200);
  }
  res.status(201).json({ ok: true });
});

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));
app.use((err, req, res, next) => res.status(err.status || 500).json({ error: err.status ? 'Invalid request.' : 'Something went wrong.' }));

app.listen(PORT, () => console.log(`Kindred is running at http://localhost:${PORT}`));
