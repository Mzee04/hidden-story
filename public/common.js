// Shared helpers for every page. No framework, no build step.
export const $ = (sel, root = document) => root.querySelector(sel);
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export async function api(path, { method = 'GET', body, headers = {} } = {}) {
  const res = await fetch(path, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty */ }
  if (!res.ok) {
    const err = new Error(data?.error || `Request failed (${res.status})`);
    err.status = res.status; err.code = data?.code; err.data = data;
    throw err;
  }
  return data;
}

let toastTimer;
export function toast(msg, kind = '') {
  let el = $('.toast');
  if (!el) { el = document.createElement('div'); el.setAttribute('role', 'status'); document.body.appendChild(el); }
  el.className = `toast ${kind}`;
  el.textContent = msg;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.remove(), kind === 'error' ? 6000 : 3000);
}

export async function copy(text) {
  try { await navigator.clipboard.writeText(text); toast('Link copied. Send it to your friends.'); }
  catch { prompt('Copy this link:', text); }
}

// Host tokens are kept in localStorage per room: they only unlock the "host" badge and the end-and-reveal button.
export const hostKey = (code) => `hs:host:${code}`;
export const playerKey = (code) => `hs:player:${code}`;
export function saveHost(code, token) { try { localStorage.setItem(hostKey(code), token); } catch {} }
export function getHost(code) { try { return localStorage.getItem(hostKey(code)); } catch { return null; } }
export function savePlayer(code, p) { try { localStorage.setItem(playerKey(code), JSON.stringify(p)); } catch {} }
export function getPlayer(code) { try { return JSON.parse(localStorage.getItem(playerKey(code)) || 'null'); } catch { return null; } }
export function lastName() { try { return localStorage.getItem('hs:name') || ''; } catch { return ''; } }
export function rememberName(n) { try { localStorage.setItem('hs:name', n); } catch {} }

export function modeBanner(mode) {
  document.querySelectorAll('.mock-banner, .warn-banner').forEach((n) => n.remove());
  if (mode === 'mock') {
    const b = document.createElement('div');
    b.className = 'mock-banner';
    b.innerHTML = '<span>Mock mode: fake referee, not Clocked, not for submission</span>';
    document.body.prepend(b);
  } else if (mode === 'unconfigured') {
    const b = document.createElement('div');
    b.className = 'warn-banner';
    b.textContent = 'The narrator is asleep: this server has no CLOCKED_API_KEY yet, so questions and guesses will not be answered.';
    document.body.prepend(b);
  }
}

export async function loadMode() {
  try { const s = await api('/api/status'); modeBanner(s.mode); return s.mode; } catch { return null; }
}
