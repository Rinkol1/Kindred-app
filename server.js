'use strict';
const express = require('express');
const crypto = require('crypto');
const { promisify } = require('util');
const { createClient } = require('@supabase/supabase-js');
const scrypt = promisify(crypto.scrypt);

const PORT = process.env.PORT || 3000;
const SESSION_MS = 7 * 24 * 60 * 60 * 1000;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variable.');
  process.exit(1);
}
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
});
const app = express();
app.set('trust proxy', 1);
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
app.use(express.static(require('path').join(__dirname, 'public')));

const uid = () => crypto.randomUUID();
const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');
const failDb = (error) => { if (error) throw error; };

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, 64);
  return salt.toString('hex') + ':' + key.toString('hex');
}
async function verifyPassword(password, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, key] = stored.split(':');
  const test = await scrypt(password, Buffer.from(salt, 'hex'), 64);
  const expected = Buffer.from(key, 'hex');
  return test.length === expected.length && crypto.timingSafeEqual(test, expected);
}
const DUMMY_HASH_PROMISE = hashPassword('not-a-real-password');

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
const publicUser = (u) => ({ id: u.id, name: u.name, age: u.age, city: u.city, bio: u.bio || '', interests: u.interests || [] });
const selfUser = (u) => ({ ...publicUser(u), email: u.email });

async function getUserById(id) {
  const { data, error } = await supabase.from('users').select('*').eq('id', id).maybeSingle();
  failDb(error); return data;
}
async function getSessionUser(token) {
  if (!token) return null;
  const { data: session, error } = await supabase.from('sessions').select('user_id, expires')
    .eq('token_hash', sha(token)).gt('expires', Date.now()).maybeSingle();
  failDb(error);
  return session ? getUserById(session.user_id) : null;
}
async function startSession(res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const { error } = await supabase.from('sessions').insert({
    token_hash: sha(token), user_id: userId, expires: Date.now() + SESSION_MS,
  });
  failDb(error);
  res.cookie('sid', token, {
    httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: SESSION_MS,
  });
}
function readCookie(req, name) {
  const hit = (req.headers.cookie || '').split(';').map((s) => s.trim()).find((s) => s.startsWith(name + '='));
  return hit ? decodeURIComponent(hit.slice(name.length + 1)) : null;
}
async function auth(req, res, next) {
  try {
    const token = readCookie(req, 'sid');
    const user = await getSessionUser(token);
    if (!user) return res.status(401).json({ error: 'Please log in.' });
    req.user = user;
    req.sessionHash = sha(token);
    next();
  } catch (e) { next(e); }
}

const hits = new Map();
const limit = (max, windowMs) => (req, res, next) => {
  const key = req.ip + req.path, now = Date.now();
  const recent = (hits.get(key) || []).filter((t) => now - t < windowMs);
  if (recent.length >= max) return res.status(429).json({ error: 'Too many attempts. Try again later.' });
  recent.push(now); hits.set(key, recent); next();
};

async function getBlocksFor(id) {
  const { data, error } = await supabase.from('blocks').select('by_id,target_id').or(`by_id.eq.${id},target_id.eq.${id}`);
  failDb(error);
  return new Set((data || []).map((b) => b.by_id === id ? b.target_id : b.by_id));
}
async function hasLiked(from, to) {
  const { data, error } = await supabase.from('swipes').select('id').eq('from_id', from).eq('to_id', to).eq('liked', true).maybeSingle();
  failDb(error); return !!data;
}
async function isMatch(a, b) {
  const blocked = await getBlocksFor(a);
  if (blocked.has(b)) return false;
  return (await hasLiked(a, b)) && (await hasLiked(b, a));
}
async function getThread(a, b) {
  const { data, error } = await supabase.from('messages').select('*')
    .or(`and(from_id.eq.${a},to_id.eq.${b}),and(from_id.eq.${b},to_id.eq.${a})`).order('created_at', { ascending: true });
  failDb(error); return data || [];
}

app.post('/api/signup', limit(10, 15 * 60 * 1000), async (req, res, next) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    const { errors, value } = validateProfile(req.body);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 120) errors.push('Enter a valid email address.');
    if (password.length < 8 || password.length > 200) errors.push('Password must be at least 8 characters.');
    if (errors.length) return res.status(400).json({ error: errors.join(' ') });
    const { data: existing, error: lookupError } = await supabase.from('users').select('id').eq('email', email).maybeSingle();
    failDb(lookupError);
    if (existing) return res.status(409).json({ error: 'That email is already registered. Log in instead.' });
    const user = { id: uid(), email, password_hash: await hashPassword(password), ...value, interests: value.interests, demo: false, created_at: Date.now() };
    const { data, error } = await supabase.from('users').insert(user).select('*').single();
    failDb(error);
    await startSession(res, data.id);
    res.status(201).json(selfUser(data));
  } catch (e) { next(e); }
});

app.post('/api/login', limit(10, 15 * 60 * 1000), async (req, res, next) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const { data: user, error } = await supabase.from('users').select('*').eq('email', email).maybeSingle();
    failDb(error);
    const ok = await verifyPassword(String(req.body.password || ''), user ? user.password_hash : await DUMMY_HASH_PROMISE);
    if (!user || !ok) return res.status(401).json({ error: 'Email or password is incorrect.' });
    await startSession(res, user.id);
    res.json(selfUser(user));
  } catch (e) { next(e); }
});

app.post('/api/logout', auth, async (req, res, next) => {
  try {
    const { error } = await supabase.from('sessions').delete().eq('token_hash', req.sessionHash); failDb(error);
    res.clearCookie('sid'); res.json({ ok: true });
  } catch (e) { next(e); }
});
app.get('/api/me', auth, (req, res) => res.json(selfUser(req.user)));
app.put('/api/me', auth, async (req, res, next) => {
  try {
    const { errors, value } = validateProfile({ ...req.user, ...req.body });
    if (errors.length) return res.status(400).json({ error: errors.join(' ') });
    const { data, error } = await supabase.from('users').update(value).eq('id', req.user.id).select('*').single();
    failDb(error); res.json(selfUser(data));
  } catch (e) { next(e); }
});
app.delete('/api/me', auth, async (req, res, next) => {
  try {
    const { error } = await supabase.from('users').delete().eq('id', req.user.id); failDb(error);
    res.clearCookie('sid'); res.json({ ok: true });
  } catch (e) { next(e); }
});

app.get('/api/discover', auth, async (req, res, next) => {
  try {
    const [{ data: users, error: ue }, { data: swipes, error: se }, blocked] = await Promise.all([
      supabase.from('users').select('*').neq('id', req.user.id),
      supabase.from('swipes').select('to_id').eq('from_id', req.user.id),
      getBlocksFor(req.user.id),
    ]);
    failDb(ue); failDb(se);
    const seen = new Set((swipes || []).map((s) => s.to_id));
    res.json((users || []).filter((u) => !seen.has(u.id) && !blocked.has(u.id)).slice(0, 20).map(publicUser));
  } catch (e) { next(e); }
});
app.post('/api/swipe', auth, async (req, res, next) => {
  try {
    const me = req.user.id, targetId = String(req.body.targetId || ''), like = req.body.like === true;
    const target = await getUserById(targetId);
    const blocked = await getBlocksFor(me);
    if (!target || target.id === me || blocked.has(target.id)) return res.status(404).json({ error: 'Profile not found.' });
    const { data: prior, error: pe } = await supabase.from('swipes').select('id').eq('from_id', me).eq('to_id', target.id).maybeSingle();
    failDb(pe);
    if (prior) return res.status(409).json({ error: 'You already responded to this profile.' });
    const { error } = await supabase.from('swipes').insert({ from_id: me, to_id: target.id, liked: like, created_at: Date.now() });
    failDb(error);
    res.json({ match: like && await isMatch(target.id, me) });
  } catch (e) { next(e); }
});
app.get('/api/matches', auth, async (req, res, next) => {
  try {
    const { data: users, error } = await supabase.from('users').select('*').neq('id', req.user.id); failDb(error);
    const result = [];
    for (const user of (users || [])) {
      if (await isMatch(req.user.id, user.id)) {
        const messages = await getThread(req.user.id, user.id);
        const last = messages[messages.length - 1];
        result.push({ ...publicUser(user), lastMessage: last ? last.message_text : null, lastAt: last ? last.created_at : 0 });
      }
    }
    result.sort((a, b) => b.lastAt - a.lastAt); res.json(result);
  } catch (e) { next(e); }
});
app.post('/api/block/:id', auth, async (req, res, next) => {
  try {
    const target = req.params.id;
    if (target === req.user.id || !(await getUserById(target))) return res.status(404).json({ error: 'Profile not found.' });
    const { error } = await supabase.from('blocks').upsert({ by_id: req.user.id, target_id: target, created_at: Date.now() }, { onConflict: 'by_id,target_id', ignoreDuplicates: true });
    failDb(error); res.json({ ok: true });
  } catch (e) { next(e); }
});
async function matchedUser(req, res) {
  const other = await getUserById(req.params.id);
  if (!other || !(await isMatch(req.user.id, other.id))) {
    res.status(403).json({ error: 'You can only message your matches.' }); return null;
  }
  return other;
}
app.get('/api/messages/:id', auth, async (req, res, next) => {
  try {
    const other = await matchedUser(req, res); if (!other) return;
    const messages = await getThread(req.user.id, other.id);
    res.json(messages.map((m) => ({ from: m.from_id === req.user.id ? 'me' : 'them', text: m.message_text, at: m.created_at })));
  } catch (e) { next(e); }
});
app.post('/api/messages/:id', auth, limit(60, 60 * 1000), async (req, res, next) => {
  try {
    const other = await matchedUser(req, res); if (!other) return;
    const messageText = String(req.body.text ?? '').trim();
    if (!messageText || messageText.length > 500) return res.status(400).json({ error: 'Messages must be 1 to 500 characters.' });
    const { error } = await supabase.from('messages').insert({ id: uid(), from_id: req.user.id, to_id: other.id, message_text: messageText, created_at: Date.now() });
    failDb(error); res.status(201).json({ ok: true });
  } catch (e) { next(e); }
});

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));
app.use((err, req, res, next) => {
  console.error('Request failed:', err && (err.message || err));
  res.status(err.status || 500).json({ error: err.status ? 'Invalid request.' : 'Something went wrong. Please try again.' });
});
app.get('/health', (req, res) => res.json({ ok: true }));
app.listen(PORT, () => console.log(`Kindred server listening on ${PORT}`));
