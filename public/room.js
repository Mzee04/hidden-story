import { $, api, toast, copy, esc, getHost, getPlayer, savePlayer, lastName, rememberName, modeBanner } from '/common.js';

const code = location.pathname.split('/')[2].toUpperCase();
const link = `${location.origin}/r/${code}`;
const hostToken = getHost(code);
let player = getPlayer(code);
let view = null;
let mode = 'ask';
let busy = false;          // a turn of ours is in flight
let coolUntil = 0;         // short client-side pause after an answer lands (mirrors the server's 800 ms)
let queued = null;         // a chip or send pressed while not ready: { text, mode }
const COOLDOWN_MS = 850;
const nodes = new Map();   // entry id -> { el, sig }

const REFUSALS = [
  'The narrator closes the book. "A clever try, but the story keeps its secrets."',
  'The candle flickers. "I answer yes, no, or not in the story. Nothing more."',
  'The narrator smiles thinly. "You will have to earn that answer, detective."',
  'A draft snuffs the question out. "The rules of this parlor do not bend."',
];
const ANSWER_LABEL = { yes: 'Yes', no: 'No', unknown: 'Not in the story' };
const HELP = {
  ask: 'The narrator answers <b>Yes</b>, <b>No</b> or <b>Not in the story</b>. Think you have it? Switch to <i>Solve</i>.',
  guess: 'Write the whole explanation. The first correct solution wins the room and reveals the story.',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function headers() {
  const h = {};
  if (hostToken) h['X-Host-Token'] = hostToken;
  if (player?.playerToken) h['X-Player-Token'] = player.playerToken;
  return h;
}

// ---------------- loading & live updates ----------------
let loading = null;
async function load(force = false) {
  if (loading) return loading;
  loading = (async () => {
    try {
      const v = !force && view ? `?v=${view.version}` : '';
      const data = await api(`/api/rooms/${code}${v}`, { headers: headers() });
      if (!data.unchanged) render(data);
    } catch (err) {
      if (err.status === 404) { $('#missing').hidden = false; $('#room').hidden = true; stopLive(); }
    } finally { loading = null; }
  })();
  return loading;
}

let es = null, pollTimer = null;
function startLive() {
  if ('EventSource' in window) {
    es = new EventSource(`/api/rooms/${code}/events`);
    es.addEventListener('version', (e) => { if (!view || Number(e.data) !== view.version) load(); });
  }
  // Fallback / safety net: slow poll when SSE is healthy, faster when it is not.
  const tick = async () => {
    const healthy = es && es.readyState === 1;
    if (!healthy || document.hidden === false) await load();
    pollTimer = setTimeout(tick, healthy ? 10000 : document.hidden ? 8000 : 2000);
  };
  pollTimer = setTimeout(tick, 2000);
}
function stopLive() { es?.close(); clearTimeout(pollTimer); }
document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });

// ---------------- rendering ----------------
const setText = (sel, t) => { const el = $(sel); if (el.textContent !== String(t)) el.textContent = t; };
const setHTML = (el, html) => { if (el.dataset.html !== html) { el.innerHTML = html; el.dataset.html = html; } };

function render(data) {
  const first = !view;
  const prevStatus = view?.status;
  view = data;
  if (first) { modeBanner(data.mode); $('#link').textContent = link; }
  document.title = `${data.title} · Hidden Story`;
  $('#room').hidden = false;
  setText('#code', data.code);
  setText('#title', data.title);
  setText('#premise', data.premise);
  $('#host-badge').hidden = !data.isHost;
  $('#end-btn').hidden = !(data.isHost && data.status === 'open');
  for (const k of ['yes', 'no', 'unknown', 'blocked']) setText(`#t-${k}`, data.counts[k]);

  if (player && !data.me) player = null; // stale token (room data reset)
  setHTML($('#players'), data.players.length
    ? data.players.map((p) => `<span class="player ${data.me?.id === p.id ? 'me' : ''}">${esc(p.name)}</span>`).join('')
    : '<span class="field-note">Nobody yet. Share the link.</span>');

  renderLog(data, first);
  if (data.status !== prevStatus) renderReveal(data, prevStatus !== undefined);
  renderChips(data);
  updateComposer();

  if (first) {
    if (!data.me && data.isHost && data.status === 'open') autoSeatHost();
    else if (!data.me && data.status === 'open') openJoin();
  }
  if (data.status !== 'open') closeJoin(false);
}

function seal(e) {
  if (e.status === 'pending') return '<span class="pending" aria-label="The narrator is thinking"><i></i><i></i><i></i> consulting the story</span>';
  if (e.status === 'error') return '<span class="seal small err">No answer</span>';
  if (e.blocked) return '<span class="seal guard">Not so fast</span>';
  if (e.kind === 'question') return `<span class="seal ${e.answer}">${ANSWER_LABEL[e.answer] || ANSWER_LABEL.unknown}</span>`;
  if (e.correct) return '<span class="seal win">Solved<small>case closed</small></span>';
  if (e.close) return '<span class="seal close">Close&hellip;<small>not quite</small></span>';
  return '<span class="seal wrong">Not it</span>';
}

function notes(e) {
  const out = [];
  if (e.status === 'error') out.push(`<div class="note">${esc(e.error)}</div>`);
  if (e.status !== 'done') return out.join('');
  if (e.blocked) {
    const line = REFUSALS[e.id % REFUSALS.length];
    out.push(`<div class="note guard"><span class="tag foiled">&#10006; Trick foiled</span> ${esc(line)}${e.category && e.category !== 'benign' ? ` <span class="tag">Guard: ${esc(e.category)}</span>` : ''}</div>`);
  } else if (e.kind === 'question' && e.keyDetail) {
    out.push('<div class="note key"><span class="tag key">&#10022; Key detail</span> You are circling something important.</div>');
  } else if (e.kind === 'question' && e.unsure) {
    out.push('<div class="note">The story does not settle that clearly. Try rephrasing.</div>');
  } else if (e.kind === 'guess' && e.close) {
    out.push('<div class="note">Part of that is right, but not the whole truth.</div>');
  }
  if (e.mock) out.push('<div class="note"><span class="tag mock">mock answer</span></div>');
  return out.join('');
}

function entryHTML(e) {
  return `<div class="bubble"><div class="who">${esc(e.name)} <span class="kind">${e.kind === 'guess' ? 'proposes a solution' : 'asks'}</span></div><div class="q">${esc(e.text)}</div></div>
    <div class="verdict">${seal(e)}</div>${notes(e)}`;
}

// Desktop: the log is its own scroller. Mobile: the page scrolls and the composer is pinned.
function logScrolls(log) { return getComputedStyle(log).overflowY === 'auto'; }

function renderLog(data, first) {
  const log = $('#log');
  const scrollsInside = logScrolls(log);
  const nearBottom = scrollsInside
    ? log.scrollHeight - log.scrollTop - log.clientHeight < 140
    : window.innerHeight + window.scrollY > document.body.scrollHeight - 260;
  let empty = $('.log-empty', log);
  if (!data.log.length) {
    if (!empty) { log.innerHTML = ''; nodes.clear(); empty = document.createElement('div'); empty.className = 'log-empty'; log.appendChild(empty); }
    empty.textContent = `The table is quiet. Ask your first yes/no question below${data.sample ? ', or tap a suggestion' : ''}.`;
    return;
  }
  empty?.remove();
  const seen = new Set();
  let added = null;
  for (const e of data.log) {
    seen.add(e.id);
    const sig = `${e.status}|${e.answer}|${e.blocked}|${e.correct}|${e.close}|${e.keyDetail}|${e.error}`;
    let n = nodes.get(e.id);
    const mine = Boolean(data.me && e.playerId === data.me.id);
    if (!n) {
      const el = document.createElement('div');
      el.className = `entry ${e.kind}${mine ? ' mine' : ''}${first ? ' no-anim' : ''}`;
      el.dataset.id = e.id;
      el.innerHTML = entryHTML(e);
      log.appendChild(el);
      nodes.set(e.id, { el, sig });
      added = el;
    } else if (n.sig !== sig) {
      n.el.classList.remove('no-anim');
      n.el.innerHTML = entryHTML(e);
      n.sig = sig;
      added = added || n.el;
    }
  }
  for (const [id, n] of nodes) if (!seen.has(id)) { n.el.remove(); nodes.delete(id); }
  if (!added && !first) return;
  if (first || nearBottom || busy) {
    if (logScrolls(log)) log.scrollTop = log.scrollHeight;
    else if (!first && added) {
      const last = log.lastElementChild;
      const r = last.getBoundingClientRect();
      const composerTop = $('#composer').getBoundingClientRect().top;
      if (r.bottom > composerTop - 8 || r.top < 0) window.scrollBy({ top: r.bottom - composerTop + 24, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    }
  }
}

function renderReveal(data, live) {
  const slot = $('#reveal-slot');
  if (!data.reveal) { slot.innerHTML = ''; return; }
  const who = data.status === 'solved'
    ? `${esc(data.winner.name)} cracked it: <i>"${esc(data.winner.guess)}"</i>`
    : 'The host ended the game and opened the envelope.';
  slot.innerHTML = `<div class="reveal parchment" tabindex="-1" id="reveal">
    <canvas class="confetti" id="confetti" aria-hidden="true"></canvas>
    <div class="eyebrow" style="color:#8e1b1b">${data.status === 'solved' ? 'Case closed' : 'The envelope is opened'}</div>
    <h2>${data.status === 'solved' ? 'Solved!' : 'The truth'}</h2>
    <div class="winner">${who}</div>
    <div class="secret">${esc(data.reveal.secret)}</div>
    <details open><summary>The full hidden story</summary><p>${esc(data.reveal.story)}</p></details>
    <div class="cta-row" style="justify-content:flex-start;margin:16px 0 0"><a class="btn btn-small btn-brass" href="/">Host another mystery</a></div>
  </div>`;
  if (!live) return;
  if (data.status === 'solved') confetti();
  setTimeout(() => {
    const behavior = matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
    if (logScrolls($('#log'))) { $('#log').scrollTop = 0; window.scrollTo({ top: 0, behavior }); } // desktop: whole room in view
    else slot.scrollIntoView({ block: 'start', behavior });                                          // mobile: below the sticky header
    $('#reveal')?.focus({ preventScroll: true });
  }, 50);
}

function usedTexts() {
  const set = new Set();
  for (const e of view?.log || []) if (e.status === 'done' || e.status === 'pending') set.add(e.text.trim().toLowerCase());
  return set;
}
function renderChips(data) {
  const chips = $('#chips');
  if (!(data.status === 'open' && data.sample && (data.suggested.length || data.injectionExample))) { setHTML(chips, ''); return; }
  const used = usedTexts();
  const chip = (q, extra = '', label = esc(q), title = '') => {
    const u = used.has(q.trim().toLowerCase());
    return `<button type="button" class="chip ${extra} ${u ? 'used' : ''}" data-q="${esc(q)}" aria-pressed="${u}"${title ? ` title="${title}"` : ''}>${u ? '<span aria-hidden="true">&#10003;</span> ' : ''}${label}</button>`;
  };
  setHTML(chips,
    data.suggested.map((q) => chip(q)).join('') +
    (data.injectionExample ? chip(data.injectionExample, 'trick', '&#9888; Try to trick the narrator', 'Sends a prompt-injection attempt. Clocked Guard should stop it.') : ''));
}

// ---------------- composer ----------------
const ready = () => Boolean(player && view && view.status === 'open' && !busy && Date.now() >= coolUntil);
function updateComposer() {
  const open = view?.status === 'open';
  $('#composer').hidden = !open;
  document.body.classList.toggle('playing', Boolean(open));
  if (!open) return;
  const seated = Boolean(player);
  const r = ready();
  $('#compose').disabled = !seated || busy;
  $('#send').disabled = !r;
  $('#join-cta').hidden = seated;
  $('#composer').classList.toggle('waiting', busy);
  for (const c of document.querySelectorAll('.chip')) c.disabled = !r;
  const help = $('#compose-help');
  const html = !seated ? 'Take a seat to ask questions.'
    : busy ? '<span class="pending"><i></i><i></i><i></i></span> The narrator is consulting the story&hellip;'
    : HELP[mode];
  if (help.dataset.html !== html) { help.innerHTML = html; help.dataset.html = html; }
}

function setMode(m, focus = false) {
  mode = m;
  for (const t of document.querySelectorAll('.tab')) {
    const on = t.dataset.mode === m;
    t.classList.toggle('active', on);
    t.setAttribute('aria-selected', String(on));
    t.tabIndex = on ? 0 : -1;
    if (on && focus) t.focus();
  }
  $('#compose-form').setAttribute('aria-labelledby', m === 'ask' ? 'tab-ask' : 'tab-guess');
  const input = $('#compose');
  input.maxLength = m === 'ask' ? 240 : 400;
  input.placeholder = m === 'ask' ? 'Was anyone hurt?' : 'I think what really happened is...';
  input.setAttribute('aria-label', m === 'ask' ? 'Your question' : 'Your solution');
  $('#send').textContent = m === 'ask' ? 'Ask' : 'Solve';
  updateComposer();
}
const tabs = () => [...document.querySelectorAll('.tab')];
for (const t of tabs()) {
  t.addEventListener('click', () => { setMode(t.dataset.mode); $('#compose').focus(); });
  t.addEventListener('keydown', (e) => {
    const list = tabs(); const i = list.indexOf(t);
    let next = null;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = list[(i + 1) % list.length];
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = list[(i - 1 + list.length) % list.length];
    else if (e.key === 'Home') next = list[0];
    else if (e.key === 'End') next = list[list.length - 1];
    if (next) { e.preventDefault(); setMode(next.dataset.mode, true); }
  });
}

function flushQueue() {
  updateComposer();
  if (queued && ready()) { const q = queued; queued = null; send(q.text, q.mode); }
}

async function send(text, kind = mode) {
  text = String(text || '').trim();
  if (text.length < 3) { toast(kind === 'ask' ? 'Ask a real question.' : 'Write out your solution.', 'error'); return; }
  if (!player) { openJoin(); return; }
  if (!ready()) { queued = { text, mode: kind }; return; } // quietly wait; flushQueue() picks it up
  busy = true; updateComposer();
  const endpoint = kind === 'ask' ? 'ask' : 'guess';
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await api(`/api/rooms/${code}/${endpoint}`, { method: 'POST', headers: headers(), body: { text } });
        if ($('#compose').value.trim() === text) $('#compose').value = '';
        busy = false;
        render(res.view);
        if (res.entry?.status === 'error') toast(res.entry.error, 'error');
        break;
      } catch (err) {
        // Busy / cooldown refusals are not errors: wait as told and resend.
        if (err.status === 429 && err.data?.retryMs && attempt < 8) { await sleep(err.data.retryMs); continue; }
        throw err;
      }
    }
  } catch (err) {
    toast(err.message, 'error');
    load(true);
  } finally {
    busy = false;
    coolUntil = Date.now() + COOLDOWN_MS;
    updateComposer();
    setTimeout(flushQueue, COOLDOWN_MS + 10);
    if (!matchMedia('(hover: none)').matches) $('#compose').focus({ preventScroll: true });
  }
}

$('#compose-form').addEventListener('submit', (e) => { e.preventDefault(); send($('#compose').value, mode); });
$('#chips').addEventListener('click', (e) => {
  const b = e.target.closest('.chip');
  if (!b || b.disabled) return;
  if (mode !== 'ask') setMode('ask');
  $('#compose').value = b.dataset.q;
  send(b.dataset.q, 'ask');
});

// ---------------- join dialog ----------------
let lastFocus = null;
function openJoin() {
  if (!view || view.status !== 'open') return;
  const ov = $('#join');
  if (!ov.hidden) return;
  lastFocus = document.activeElement;
  $('#join-title').textContent = view.title;
  $('#join-premise').textContent = view.premise;
  const n = $('#name');
  if (!n.value) n.value = lastName();
  ov.hidden = false;
  document.body.classList.add('modal-open');
  setTimeout(() => { n.focus(); n.select(); }, 30);
}
function closeJoin(restore = true) {
  const ov = $('#join');
  if (ov.hidden) return;
  ov.hidden = true;
  document.body.classList.remove('modal-open');
  if (restore && lastFocus && document.contains(lastFocus)) lastFocus.focus();
  updateComposer();
}
$('#join').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { e.preventDefault(); closeJoin(); $('#join-cta').focus(); return; }
  if (e.key !== 'Tab') return;
  const f = [...$('#join').querySelectorAll('input, button')].filter((x) => !x.disabled);
  const firstEl = f[0], lastEl = f[f.length - 1];
  if (e.shiftKey && document.activeElement === firstEl) { e.preventDefault(); lastEl.focus(); }
  else if (!e.shiftKey && document.activeElement === lastEl) { e.preventDefault(); firstEl.focus(); }
});
$('#join').addEventListener('click', (e) => { if (e.target.id === 'join') closeJoin(); });
$('#join-later').addEventListener('click', () => closeJoin());
$('#join-cta').addEventListener('click', openJoin);

async function join(name) {
  const p = await api(`/api/rooms/${code}/join`, { method: 'POST', headers: headers(), body: { name } });
  player = p; savePlayer(code, p); rememberName(name);
  return p;
}
$('#join-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('#name').value.trim();
  if (!name) return;
  try {
    await join(name);
    closeJoin(false);
    await load(true);
    $('#compose').focus();
  } catch (err) { toast(err.message, 'error'); }
});
// A host who opened the room (e.g. an older link) is seated without the modal.
async function autoSeatHost() {
  try { await join(lastName() || 'Host'); await load(true); } catch { openJoin(); }
}

// ---------------- misc ----------------
$('#copy-link').addEventListener('click', () => copy(link));
$('#copy-link-2').addEventListener('click', () => copy(link));
$('#end-btn').addEventListener('click', async () => {
  if (!confirm('End the game and reveal the secret to everyone?')) return;
  try { render(await api(`/api/rooms/${code}/reveal`, { method: 'POST', headers: headers(), body: {} })); }
  catch (err) { toast(err.message, 'error'); }
});

function confetti() {
  const c = document.getElementById('confetti');
  if (!c || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const ctx = c.getContext('2d');
  const W = (c.width = c.offsetWidth), H = (c.height = c.offsetHeight);
  const colors = ['#c9a45c', '#8e1b1b', '#2f6a43', '#f1d796', '#4a1420'];
  const bits = Array.from({ length: 90 }, () => ({ x: Math.random() * W, y: -20 - Math.random() * H, r: 3 + Math.random() * 4, v: 1.5 + Math.random() * 2.5, s: Math.random() * 6, c: colors[(Math.random() * colors.length) | 0] }));
  let t = 0;
  (function frame() {
    ctx.clearRect(0, 0, W, H);
    for (const b of bits) { b.y += b.v; b.x += Math.sin((t + b.s) / 12); ctx.fillStyle = b.c; ctx.fillRect(b.x, b.y, b.r, b.r * 1.6); }
    if (++t < 260) requestAnimationFrame(frame); else ctx.clearRect(0, 0, W, H);
  })();
}

setMode('ask');
load(true).then(startLive);
