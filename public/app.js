'use strict';
const $ = (s) => document.querySelector(s);
const state = { me: null, queue: [], timer: null };

/* ---------- Helpers ---------- */
function el(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v);
  }
  kids.flat().forEach((c) => n.append(c));
  return n;
}
async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || 'Something went wrong.');
    err.status = res.status;
    throw err;
  }
  return data;
}
const hue = (id) => [...id].reduce((a, c) => a + c.charCodeAt(0), 0) % 360;
const grad = (id) => `linear-gradient(150deg,hsl(${hue(id)} 70% 55%),hsl(${(hue(id) + 50) % 360} 65% 35%))`;
let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 2400);
}
function fail(e) {
  if (e.status === 401) { state.me = null; renderAuth('login'); } else toast(e.message);
}
const stopPolling = () => { clearInterval(state.timer); state.timer = null; };

/* ---------- Shared profile form (used by sign up and profile editing) ---------- */
function profileFields(v = {}) {
  const f = {
    name: el('input', { autocomplete: 'given-name', maxlength: '40', required: '' }),
    age: el('input', { type: 'number', min: '18', max: '99', required: '' }),
    city: el('input', { maxlength: '60', required: '' }),
    bio: el('textarea', { rows: '3', maxlength: '300' }),
    interests: el('input', { placeholder: 'Hiking, jazz, cooking' }),
  };
  const labels = { name: 'First name', age: 'Age (18 or older)', city: 'City', bio: 'About you', interests: 'Interests (up to 6, separated by commas)' };
  f.name.value = v.name || '';
  f.age.value = v.age || '';
  f.city.value = v.city || '';
  f.bio.value = v.bio || '';
  f.interests.value = (v.interests || []).join(', ');
  return {
    nodes: Object.keys(f).map((k) => el('label', { class: 'field' }, el('span', {}, labels[k]), f[k])),
    read: () => Object.fromEntries(Object.entries(f).map(([k, i]) => [k, i.value])),
  };
}

/* ---------- Log in and sign up ---------- */
function renderAuth(mode = 'login') {
  stopPolling();
  state.queue = [];
  const signup = mode === 'signup';
  const err = el('p', { class: 'error', role: 'alert' });
  const email = el('input', { type: 'email', autocomplete: 'email', required: '', maxlength: '120' });
  const password = el('input', { type: 'password', autocomplete: signup ? 'new-password' : 'current-password', required: '', minlength: signup ? '8' : '1' });
  const prof = signup ? profileFields() : null;

  const form = el('form', { class: 'card pad' },
    el('h2', {}, signup ? 'Create your profile' : 'Log in'),
    el('label', { class: 'field' }, el('span', {}, 'Email'), email),
    el('label', { class: 'field' }, el('span', {}, signup ? 'Password (at least 8 characters)' : 'Password'), password),
    prof ? prof.nodes : [],
    err,
    el('button', { class: 'primary wide', type: 'submit' }, signup ? 'Sign up' : 'Log in'),
    el('p', { class: 'swap' }, signup ? 'Already a member? ' : 'New here? ',
      el('button', { type: 'button', class: 'link', onclick: () => renderAuth(signup ? 'login' : 'signup') }, signup ? 'Log in' : 'Create an account')));

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.textContent = '';
    try {
      const body = { email: email.value, password: password.value, ...(prof ? prof.read() : {}) };
      state.me = await api('POST', signup ? '/api/signup' : '/api/login', body);
      startApp();
    } catch (ex) {
      err.textContent = ex.message;
    }
  });
  $('#root').replaceChildren(el('header', {}, el('h1', {}, 'Kindred')), form);
}

/* ---------- App shell ---------- */
function startApp() {
  const tabs = ['discover', 'matches', 'profile'];
  const nav = el('nav', { role: 'tablist' },
    tabs.map((t) => el('button', { role: 'tab', 'data-tab': t, onclick: () => show(t) }, t[0].toUpperCase() + t.slice(1))));
  $('#root').replaceChildren(el('header', {}, el('h1', {}, 'Kindred'), nav), el('main', { id: 'view' }));
  show('discover');
}
function show(tab) {
  stopPolling();
  document.querySelectorAll('[data-tab]').forEach((b) => b.setAttribute('aria-selected', b.dataset.tab === tab));
  ({ discover: renderDiscover, matches: renderMatches, profile: renderProfile })[tab]();
}

/* ---------- Discover ---------- */
async function renderDiscover() {
  try {
    if (!state.queue.length) state.queue = await api('GET', '/api/discover');
  } catch (e) { return fail(e); }
  const v = $('#view');
  const p = state.queue[0];
  if (!p) {
    v.replaceChildren(el('div', { class: 'card empty' },
      el('h2', {}, 'You’re all caught up'),
      el('p', {}, 'No new profiles right now. Check back soon or look at your matches.'),
      el('button', { class: 'primary', onclick: renderDiscover }, 'Refresh')));
    return;
  }
  v.replaceChildren(
    el('article', { class: 'card' },
      el('div', { class: 'photo', style: `background:${grad(p.id)}` },
        el('div', { class: 'initial', 'aria-hidden': 'true' }, p.name[0]),
        el('h2', {}, p.name, ' ', el('span', {}, String(p.age)))),
      el('div', { class: 'info' },
        el('p', { class: 'city' }, p.city),
        el('p', { class: 'bio' }, p.bio || 'No bio yet.'),
        el('ul', { class: 'tags' }, p.interests.map((t) => el('li', {}, t))))),
    el('div', { class: 'actions' },
      el('button', { class: 'round', 'aria-label': 'Pass on ' + p.name, onclick: () => respond(p, false) }, 'Pass'),
      el('button', { class: 'round like', 'aria-label': 'Like ' + p.name, onclick: () => respond(p, true) }, 'Like')));
}
async function respond(p, like) {
  try {
    const r = await api('POST', '/api/swipe', { targetId: p.id, like });
    state.queue.shift();
    if (r.match) toast(`It’s a match with ${p.name}`);
    renderDiscover();
  } catch (e) { fail(e); }
}

/* ---------- Matches and chat ---------- */
async function renderMatches() {
  let list;
  try { list = await api('GET', '/api/matches'); } catch (e) { return fail(e); }
  const v = $('#view');
  if (!list.length) {
    v.replaceChildren(el('div', { class: 'card empty' }, el('h2', {}, 'No matches yet'), el('p', {}, 'When you and another member like each other, you’ll see them here.')));
    return;
  }
  v.replaceChildren(el('div', { class: 'card' }, list.map((m) =>
    el('button', { class: 'row', onclick: () => openChat(m) },
      el('div', { class: 'avatar', style: `background:${grad(m.id)}` }, m.name[0]),
      el('div', {}, el('strong', {}, m.name), el('small', {}, m.lastMessage || 'Say hello'))))));
}

function openChat(m) {
  const msgs = el('div', { class: 'msgs', 'aria-live': 'polite' });
  const input = el('input', { type: 'text', placeholder: 'Write a message', 'aria-label': 'Message', maxlength: '500' });
  let count = -1;

  async function load() {
    try {
      const list = await api('GET', '/api/messages/' + m.id);
      if (list.length === count) return;
      count = list.length;
      msgs.replaceChildren(...list.map((x) => el('div', { class: 'msg ' + x.from }, x.text)));
      msgs.scrollTop = msgs.scrollHeight;
    } catch (e) { fail(e); }
  }
  async function send() {
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    try { await api('POST', '/api/messages/' + m.id, { text }); load(); } catch (e) { fail(e); }
  }
  async function block() {
    if (!confirm(`Block ${m.name}? You won’t see each other or be able to message again.`)) return;
    try { await api('POST', '/api/block/' + m.id); toast(m.name + ' is blocked'); show('matches'); } catch (e) { fail(e); }
  }
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });

  $('#view').replaceChildren(el('div', { class: 'card chat' },
    el('div', { class: 'chat-head' },
      el('button', { class: 'link', onclick: () => show('matches') }, 'Back'),
      el('div', { class: 'avatar', style: `background:${grad(m.id)}` }, m.name[0]),
      el('strong', {}, m.name),
      el('button', { class: 'link danger', onclick: block }, 'Block')),
    msgs,
    el('div', { class: 'send' }, input, el('button', { class: 'primary', onclick: send }, 'Send'))));
  load();
  state.timer = setInterval(load, 3000);
  input.focus();
}

/* ---------- Profile editing ---------- */
function renderProfile() {
  const prof = profileFields(state.me);
  const err = el('p', { class: 'error', role: 'alert' });
  const form = el('form', { class: 'card pad' },
    el('h2', {}, 'Edit your profile'),
    el('p', { class: 'mute' }, 'Signed in as ' + state.me.email),
    prof.nodes,
    err,
    el('button', { class: 'primary wide', type: 'submit' }, 'Save changes'),
    el('div', { class: 'btns' },
      el('button', { class: 'ghost', type: 'button', onclick: logout }, 'Log out'),
      el('button', { class: 'ghost danger', type: 'button', onclick: deleteAccount }, 'Delete account')));

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.textContent = '';
    try {
      state.me = await api('PUT', '/api/me', prof.read());
      toast('Profile saved');
    } catch (ex) {
      if (ex.status === 401) fail(ex); else err.textContent = ex.message;
    }
  });
  $('#view').replaceChildren(form);
}
async function logout() {
  try { await api('POST', '/api/logout'); } catch (e) { /* already logged out */ }
  state.me = null;
  renderAuth('login');
}
async function deleteAccount() {
  if (!confirm('Delete your account, matches and messages? This can’t be undone.')) return;
  try { await api('DELETE', '/api/me'); state.me = null; renderAuth('signup'); toast('Account deleted'); } catch (e) { fail(e); }
}

/* ---------- Start ---------- */
(async () => {
  try { state.me = await api('GET', '/api/me'); startApp(); } catch (e) { renderAuth('login'); }
})();
