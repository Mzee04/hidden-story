// Smoke test against a running server: node scripts/smoke.js [baseUrl]
// No key: checks pages, rooms, and that questions fail clearly. Mock or live: plays the full sample path.
const base = process.argv[2] || `http://localhost:${process.env.PORT || 3000}`;
const j = async (path, opts = {}) => {
  const res = await fetch(base + path, { ...opts, headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) } });
  const text = await res.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body, headers: res.headers };
};
let failed = 0;
const ok = (cond, msg) => { if (!cond) { failed++; console.error('FAIL', msg); } else console.log('ok  ', msg); };
const post = (path, body, headers = {}) => j(path, { method: 'POST', headers, body: JSON.stringify(body || {}) });

const status = await j('/api/status');
const mode = status.body.mode;
ok(status.status === 200, `status: mode=${mode}`);
for (const p of ['/', '/how', '/styles.css', '/room.js', '/page.js']) {
  const r = await fetch(base + p);
  ok(r.status === 200, `GET ${p}`);
  if (p === '/') ok(r.headers.get('content-security-policy')?.includes("frame-ancestors 'none'") && r.headers.get('x-content-type-options') === 'nosniff', 'security headers present');
}
ok((await fetch(base + '/nope')).status === 404, '404 page');

// Sample room: host is auto-seated.
const s = await post('/api/rooms/sample', { hostName: 'Smoke Host' });
const code = s.body.code;
ok(s.status === 201 && code && s.body.playerToken && s.body.hostToken && s.body.name === 'Smoke Host', `sample room ${code} with host auto-joined`);
const H = { 'X-Player-Token': s.body.playerToken, 'X-Host-Token': s.body.hostToken };
const page = await (await fetch(`${base}/r/${code}`)).text();
ok(page.includes('og:title') && page.includes('The Silent Ovation') && !/sign language|Deaf/.test(page), 'room page has OG tags, no secret');
const room = await j(`/api/rooms/${code}`, { headers: H });
ok(room.body.me?.name === 'Smoke Host' && room.body.isHost, 'host is seated in the room view');
ok(!/sign language|Deaf/.test(JSON.stringify(room.body)), 'room view does not leak the hidden story');
ok(room.body.reveal === null && room.body.suggested.length === 3 && room.body.injectionExample, 'sample has 3 suggestions + injection example');

// SSE stream answers with the current version.
{
  const ctrl = new AbortController();
  const r = await fetch(`${base}/api/rooms/${code}/events`, { signal: ctrl.signal });
  const reader = r.body.getReader();
  const { value } = await reader.read();
  ok(r.headers.get('content-type')?.startsWith('text/event-stream') && new TextDecoder().decode(value).includes('event: version'), 'SSE events stream');
  ctrl.abort();
}

if (mode === 'unconfigured') {
  const ask = await post(`/api/rooms/${code}/ask`, { text: 'Could the audience hear the music?' }, H);
  ok(ask.status === 503 && /CLOCKED_API_KEY/.test(ask.body.error), `ask without key fails clearly: "${ask.body.error}"`);
} else {
  // Back-to-back, no artificial waiting: the client would auto-retry a quiet COOLDOWN, so the smoke does too.
  const turn = async (kind, text) => {
    for (let i = 0; i < 6; i++) {
      const r = await post(`/api/rooms/${code}/${kind}`, { text }, H);
      if (r.status === 429 && r.body.retryMs) { ok(['COOLDOWN', 'BUSY'].includes(r.body.code) && r.body.retryMs <= 900, `  quiet ${r.body.code} retry in ${r.body.retryMs}ms`); await new Promise((x) => setTimeout(x, r.body.retryMs)); continue; }
      return r;
    }
    return { status: 0, body: {} };
  };
  const expected = mode === 'mock' ? ['no', 'yes', 'no'] : null;
  const t0 = Date.now();
  for (const [i, q] of room.body.suggested.entries()) {
    const r = await turn('ask', q);
    const e = r.body.entry;
    ok(r.status === 200 && e?.status === 'done' && !e.blocked, `"${q}" -> ${e?.answer}${e?.blocked ? ' (BLOCKED)' : ''}`);
    if (expected) ok(e?.answer === expected[i], `  mock answer is ${expected[i]}`);
  }
  const trick = await turn('ask', room.body.injectionExample);
  ok(trick.status === 200 && trick.body.entry.blocked === true && trick.body.entry.answer === undefined, `trick blocked by Guard (${trick.body.entry?.category}), no answer given`);
  const benign = await turn('ask', 'Is the answer related to music?');
  ok(benign.status === 200 && !benign.body.entry.blocked, 'ordinary loose question stays benign');
  const wrong = await turn('guess', 'They were asleep.');
  ok(wrong.status === 200 && !wrong.body.entry.blocked && wrong.body.entry.correct === false && wrong.body.view.status === 'open', 'wrong guess is benign and not a win');
  const win = await turn('guess', 'The audience was Deaf, and they gave her a standing ovation in sign language by waving their hands, which makes no sound.');
  ok(win.status === 200 && win.body.entry.correct === true && win.body.view.status === 'solved', 'correct guess solves the room');
  ok(win.body.view.reveal?.story?.includes('sign language') && win.body.view.winner?.name === 'Smoke Host', 'story revealed, winner shown');
  ok(Date.now() - t0 < 15000, `full sample path in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  const after = await post(`/api/rooms/${code}/ask`, { text: 'Was anyone hurt?' }, H);
  ok(after.status === 409, 'no questions after the room is solved');
}

// Friends join via link.
const f = await post(`/api/rooms/${code}/join`, { name: 'Friend' });
ok(f.status === 201 && f.body.playerToken, 'friend can join with a name');

// Custom room: host auto-joined, validation, host-only reveal.
const bad = await post('/api/rooms', { premise: 'x' });
ok(bad.status === 400, 'create validation');
const c = await post('/api/rooms', { title: 'T', premise: 'A man walks into a bar and asks for water.', story: 'He had hiccups; the bartender startled him to cure them.', secret: 'He had hiccups.' });
ok(c.status === 201 && c.body.playerToken && c.body.name === 'Host', 'create custom room, host auto-joined as "Host"');
ok((await post(`/api/rooms/${c.body.code}/reveal`)).status === 403, 'reveal requires host');
const rev = await post(`/api/rooms/${c.body.code}/reveal`, {}, { 'X-Host-Token': c.body.hostToken });
ok(rev.status === 200 && rev.body.status === 'revealed' && rev.body.isHost, 'host can end & reveal');
ok((await j('/api/rooms/ZZZZZZ')).status === 404, 'unknown room 404');

console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed');
process.exitCode = failed ? 1 : 0;
