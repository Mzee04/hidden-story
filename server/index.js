import { ROOT } from './env.js';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import * as store from './store.js';
import * as clocked from './clocked.js';
import { SAMPLE } from './sample.js';

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC = join(ROOT, 'public');

const LIMITS = { title: 80, premise: 600, story: 4000, secret: 600, name: 24, question: 240, guess: 400 };
const COOLDOWN_MS = 800;       // per player, counted from when their previous turn FINISHED
const MAX_ROOM_INFLIGHT = 4;   // concurrent Clocked calls per room
const MAX_LOG = 300;

const clean = (s, max) => String(s ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, max);
const safeEq = (a, b) => {
  const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
};

class HttpError extends Error {
  constructor(status, message, extra = {}) { super(message); this.status = status; this.extra = extra; }
}

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data:",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');
const SECURITY = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': CSP,
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

function send(res, status, body, headers = {}) {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': typeof body === 'object' && !Buffer.isBuffer(body) ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    ...SECURITY,
    ...headers,
  });
  res.end(data);
}

async function readJson(req) {
  let size = 0; const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 32 * 1024) throw new HttpError(413, 'That is a very long scroll. Please shorten it.');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new HttpError(400, 'Invalid JSON.'); }
}

// ---------- room helpers ----------
function createRoom({ title, premise, story, secret, sample = false, suggested = [], injection = null }) {
  const room = {
    code: store.newCode(),
    title, premise, story, secret,
    sample, suggested, injection,
    hostToken: store.token(),
    status: 'open',            // open | solved | revealed
    winner: null,              // { name, guess, at }
    players: {},               // id -> { id, name, token, joinedAt, lastAt }
    log: [],
    nextId: 1,
    version: 1,
    inflight: 0,
    createdAt: Date.now(),
    lastActiveAt: Date.now(),
  };
  return store.putRoom(room);
}

function addPlayer(room, name) {
  const p = { id: `p${Object.keys(room.players).length + 1}`, name, token: store.token(), joinedAt: Date.now() };
  room.players[p.id] = p;
  return p;
}

// Live updates: Server-Sent Events push the room version; clients then fetch their own view (with their tokens).
const subscribers = new Map(); // code -> Set<res>
function notify(room) {
  const subs = subscribers.get(room.code);
  if (!subs) return;
  for (const res of subs) res.write(`event: version\ndata: ${room.version}\n\n`);
}
function subscribe(req, res, room) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    ...SECURITY,
  });
  res.write(`retry: 3000\nevent: version\ndata: ${room.version}\n\n`);
  if (!subscribers.has(room.code)) subscribers.set(room.code, new Set());
  const set = subscribers.get(room.code);
  if (set.size >= 200) { res.end(); return; }
  set.add(res);
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => { clearInterval(ping); set.delete(res); if (!set.size) subscribers.delete(room.code); });
}

function touch(room) { room.version++; room.lastActiveAt = Date.now(); store.save(); notify(room); }

// Host is seated automatically so they land in their own room ready to play.
function created(res, room, hostName) {
  const name = clean(hostName, LIMITS.name) || 'Host';
  const p = addPlayer(room, name);
  touch(room);
  return send(res, 201, { code: room.code, hostToken: room.hostToken, playerId: p.id, playerToken: p.token, name });
}

function publicView(room, viewer) {
  const done = room.status !== 'open';
  const counts = { questions: 0, yes: 0, no: 0, unknown: 0, blocked: 0, guesses: 0 };
  for (const e of room.log) {
    if (e.status !== 'done') continue;
    if (e.blocked) counts.blocked++;
    else if (e.kind === 'question') { counts.questions++; counts[e.answer]++; }
    else if (e.kind === 'guess') counts.guesses++;
  }
  return {
    code: room.code,
    title: room.title,
    premise: room.premise,
    sample: room.sample,
    suggested: room.sample && !done ? room.suggested : [],
    injectionExample: room.sample && !done ? room.injection : null,
    status: room.status,
    winner: room.winner,
    // The story and secret are only ever sent once the room is over.
    reveal: done ? { story: room.story, secret: room.secret } : null,
    players: Object.values(room.players).map((p) => ({ id: p.id, name: p.name })),
    log: room.log.slice(-MAX_LOG).map((e) => ({
      id: e.id, kind: e.kind, playerId: e.playerId, name: e.name, text: e.text, at: e.at, status: e.status,
      answer: e.answer, unsure: e.unsure, keyDetail: e.keyDetail, correct: e.correct, close: e.close,
      blocked: e.blocked, category: e.category, evidence: e.evidence, error: e.error, mock: e.mock,
    })),
    counts,
    version: room.version,
    isHost: Boolean(viewer?.host),
    me: viewer?.player ? { id: viewer.player.id, name: viewer.player.name } : null,
    mode: clocked.mode(),
  };
}

function viewerFor(room, req, body = {}) {
  const hostTok = req.headers['x-host-token'] || body.hostToken;
  const playerTok = req.headers['x-player-token'] || body.playerToken;
  const host = safeEq(hostTok, room.hostToken);
  const player = Object.values(room.players).find((p) => safeEq(playerTok, p.token)) || null;
  return { host, player };
}

function requireRoom(code) {
  const room = store.getRoom(code);
  if (!room) throw new HttpError(404, 'No room with that code. Check the link with your host.');
  return room;
}

// The core turn: Guard first (player text only), then Decide (hidden story as state) only if benign.
async function playTurn(room, player, kind, text) {
  if (room.status !== 'open') throw new HttpError(409, 'This mystery has already been solved.');
  if (clocked.mode() === 'unconfigured') throw new HttpError(503, new clocked.NotConfiguredError().message, { code: 'NOT_CONFIGURED' });
  const now = Date.now();
  // Quiet, retryable refusals: the client waits `retryMs` and resends instead of showing an error.
  if (player.busy) throw new HttpError(429, 'The narrator is still answering your last one.', { code: 'BUSY', retryMs: 600 });
  const wait = COOLDOWN_MS - (now - (player.doneAt || 0));
  if (wait > 0) throw new HttpError(429, 'One moment.', { code: 'COOLDOWN', retryMs: wait + 50 });
  if (room.inflight >= MAX_ROOM_INFLIGHT) throw new HttpError(429, 'The narrator is busy with other questions.', { code: 'ROOM_BUSY', retryMs: 1200 });

  const entry = { id: room.nextId++, kind, playerId: player.id, name: player.name, text, at: now, status: 'pending' };
  room.log.push(entry);
  if (room.log.length > MAX_LOG * 2) room.log = room.log.slice(-MAX_LOG);
  player.busy = true; room.inflight++;
  touch(room);

  try {
    const g = await clocked.guard(text);
    if (g.mock) entry.mock = true;
    if (g.blocked) {
      Object.assign(entry, { status: 'done', blocked: true, category: g.category, evidence: g.evidence });
      return entry;
    }
    if (kind === 'question') {
      const r = await clocked.answerQuestion(room, text);
      Object.assign(entry, { status: 'done', answer: r.answer, unsure: r.unsure, keyDetail: r.keyDetail });
    } else {
      const r = await clocked.judgeGuess(room, text);
      Object.assign(entry, { status: 'done', correct: r.correct, close: r.close });
      // First correct guess wins (calls resolve one at a time on the event loop, so this check is atomic).
      if (r.correct && room.status === 'open') {
        room.status = 'solved';
        room.winner = { name: player.name, playerId: player.id, guess: text, at: Date.now() };
      } else if (r.correct) {
        entry.late = true;
      }
    }
    return entry;
  } catch (err) {
    entry.status = 'error';
    entry.error = err instanceof clocked.NotConfiguredError
      ? err.message
      : err?.code === 'MALFORMED'
        ? 'The narrator mumbled (Clocked sent an unexpected answer). Please ask again.'
        : 'The narrator lost the thread (Clocked did not answer). Please ask again.';
    console.error(`[turn] room ${room.code} ${kind} failed:`, err?.name, err?.status ?? '', err?.error || err?.message);
    return entry;
  } finally {
    player.busy = false; player.doneAt = Date.now(); room.inflight = Math.max(0, room.inflight - 1);
    touch(room);
  }
}

// ---------- routes ----------
async function api(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]
  const method = req.method;

  if (parts[1] === 'status' && method === 'GET') {
    return send(res, 200, { mode: clocked.mode(), rooms: store.roomCount() });
  }

  if (parts[1] === 'rooms' && parts.length === 2 && method === 'POST') {
    const b = await readJson(req);
    const room = {
      title: clean(b.title, LIMITS.title) || 'An Untitled Mystery',
      premise: clean(b.premise, LIMITS.premise),
      story: clean(b.story, LIMITS.story),
      secret: clean(b.secret, LIMITS.secret),
    };
    if (room.premise.length < 10) throw new HttpError(400, 'Give your players a premise (at least a sentence).');
    if (room.story.length < 20) throw new HttpError(400, 'The hidden story needs a little more detail (at least 20 characters).');
    if (room.secret.length < 5) throw new HttpError(400, 'Write the secret answer players must guess.');
    return created(res, createRoom(room), b.hostName);
  }

  if (parts[1] === 'rooms' && parts[2] === 'sample' && method === 'POST') {
    const b = await readJson(req);
    return created(res, createRoom({ ...SAMPLE, sample: true }), b.hostName);
  }

  if (parts[1] === 'rooms' && parts[2]) {
    const room = requireRoom(parts[2]);
    const action = parts[3];

    if (action === 'events' && method === 'GET') return subscribe(req, res, room);

    if (!action && method === 'GET') {
      const viewer = viewerFor(room, req);
      const since = Number(url.searchParams.get('v') || 0);
      if (since && since === room.version && !viewer.host) return send(res, 200, { unchanged: true, version: room.version });
      return send(res, 200, publicView(room, viewer));
    }

    if (method !== 'POST') throw new HttpError(405, 'Method not allowed.');
    const b = await readJson(req);
    const viewer = viewerFor(room, req, b);

    if (action === 'join') {
      const name = clean(b.name, LIMITS.name);
      if (!name) throw new HttpError(400, 'Pick a detective name.');
      if (viewer.player) {
        viewer.player.name = name; touch(room);
        return send(res, 200, { playerId: viewer.player.id, playerToken: viewer.player.token, name });
      }
      if (Object.keys(room.players).length >= 64) throw new HttpError(409, 'This parlor is full.');
      const p = addPlayer(room, name);
      touch(room);
      return send(res, 201, { playerId: p.id, playerToken: p.token, name });
    }

    if (action === 'ask' || action === 'guess') {
      if (!viewer.player) throw new HttpError(401, 'Join the room with a name first.');
      const kind = action === 'ask' ? 'question' : 'guess';
      const text = clean(b.text, kind === 'question' ? LIMITS.question : LIMITS.guess);
      if (text.length < 3) throw new HttpError(400, kind === 'question' ? 'Ask a real question.' : 'Write out your solution.');
      const entry = await playTurn(room, viewer.player, kind, text);
      return send(res, 200, { entry: publicView(room, viewer).log.find((e) => e.id === entry.id), view: publicView(room, viewer) });
    }

    if (action === 'reveal') {
      if (!viewer.host) throw new HttpError(403, 'Only the host can end the game.');
      if (room.status === 'open') { room.status = 'revealed'; touch(room); }
      return send(res, 200, publicView(room, viewer));
    }
  }
  throw new HttpError(404, 'Not found.');
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };
const escHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// Room page with Open Graph tags filled from the PUBLIC title and premise only (never the story or secret).
async function serveRoom(req, res, code) {
  const room = store.getRoom(code);
  let html = await readFile(join(PUBLIC, 'room.html'), 'utf8');
  const title = room ? `${room.title} · Hidden Story` : 'Hidden Story: a mystery room';
  const premise = room ? room.premise : 'Join a yes/no mystery. Ask questions until someone cracks it.';
  const desc = premise.length > 180 ? `${premise.slice(0, 177)}...` : premise;
  const host = req.headers.host && /^[\w.:-]+$/.test(req.headers.host) ? req.headers.host : `localhost:${PORT}`;
  html = html
    .replaceAll('{{OG_TITLE}}', escHtml(title))
    .replaceAll('{{OG_DESC}}', escHtml(desc))
    .replaceAll('{{OG_URL}}', escHtml(`http://${host}/r/${room ? room.code : String(code).toUpperCase()}`));
  res.writeHead(room ? 200 : 404, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', ...SECURITY });
  res.end(html);
}

async function serveFile(res, rel, status = 200) {
  const path = normalize(join(PUBLIC, rel));
  if (!path.startsWith(PUBLIC)) return send(res, 403, 'Forbidden');
  try {
    const body = await readFile(path);
    res.writeHead(status, {
      'Content-Type': TYPES[extname(path)] || 'application/octet-stream',
      'Cache-Control': extname(path) === '.html' ? 'no-cache' : 'public, max-age=300',
      ...SECURITY,
    });
    res.end(body);
  } catch {
    if (rel !== '404.html') return serveFile(res, '404.html', 404);
    send(res, 404, 'Not found');
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
    if (url.pathname === '/') return serveFile(res, 'index.html');
    if (url.pathname === '/how' || url.pathname === '/how-it-works') return serveFile(res, 'how.html');
    const m = url.pathname.match(/^\/r\/([A-Za-z0-9]{4,10})\/?$/);
    if (m) return serveRoom(req, res, m[1]);
    if (url.pathname === '/room.html') return serveFile(res, '404.html', 404);
    return serveFile(res, url.pathname.slice(1));
  } catch (err) {
    if (err instanceof HttpError) return send(res, err.status, { error: err.message, ...err.extra });
    console.error('[http]', err?.message);
    return send(res, 500, { error: 'Something went wrong in the parlor.' });
  }
});

server.listen(PORT, () => {
  const m = clocked.mode();
  console.log(`Hidden Story running at http://localhost:${PORT}`);
  if (m === 'live') console.log('Clocked: live (CLOCKED_API_KEY is set).');
  else if (m === 'mock') console.log('Clocked: MOCK MODE (CLOCKED_MOCK=1). Fake referee for local UI review only. NOT for submission.');
  else console.log('Clocked: not configured. Pages work; questions and guesses return a clear error until CLOCKED_API_KEY is set.');
});

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { store.flushNow(); process.exit(0); });
