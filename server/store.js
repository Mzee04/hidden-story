// Simple durable store: rooms live in memory and are flushed atomically to data/rooms.json.
// Survives restarts; no native modules required (Node 18+).
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { ROOT } from './env.js';

const DATA_DIR = process.env.DATA_DIR || join(ROOT, 'data');
const FILE = join(DATA_DIR, 'rooms.json');
mkdirSync(DATA_DIR, { recursive: true });

let rooms = {};
if (existsSync(FILE)) {
  try {
    rooms = JSON.parse(readFileSync(FILE, 'utf8')).rooms || {};
    // Anything left "pending" when the server stopped will never finish.
    for (const room of Object.values(rooms)) {
      room.inflight = 0;
      for (const p of Object.values(room.players || {})) p.busy = false;
      for (const entry of room.log) {
        if (entry.status === 'pending') {
          entry.status = 'error';
          entry.error = 'The narrator was interrupted (server restarted). Ask again.';
        }
      }
    }
  } catch (err) {
    console.error('[store] could not read rooms.json, starting empty:', err.message);
  }
}

let timer = null;
function flush() {
  timer = null;
  const tmp = FILE + '.tmp';
  writeFileSync(tmp, JSON.stringify({ rooms }, null, 0));
  renameSync(tmp, FILE);
}
export function save() {
  if (!timer) timer = setTimeout(flush, 150);
}
export function flushNow() {
  if (timer) { clearTimeout(timer); flush(); }
}

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export function newCode() {
  for (;;) {
    const bytes = randomBytes(6);
    let code = '';
    for (const b of bytes) code += ALPHABET[b % ALPHABET.length];
    if (!rooms[code]) return code;
  }
}
export const token = () => randomBytes(18).toString('base64url');

export function getRoom(code) {
  return rooms[String(code || '').toUpperCase()] || null;
}
export function putRoom(room) {
  rooms[room.code] = room;
  save();
  return room;
}
// Room TTL: rooms expire after ROOM_TTL_DAYS without activity, but never before KEEP_UNTIL
// (Clocked Build Challenge winners are announced Nov 18, 2026; keep a cushion for judges reopening links).
export const ROOM_TTL_DAYS = Number(process.env.ROOM_TTL_DAYS) || 30;
export const KEEP_UNTIL = Date.parse(process.env.ROOM_KEEP_UNTIL || '2026-12-15T00:00:00Z');
export function sweep(now = Date.now()) {
  if (now < KEEP_UNTIL) return 0;
  const cutoff = now - ROOM_TTL_DAYS * 86400000;
  let removed = 0;
  for (const [code, room] of Object.entries(rooms)) {
    const last = room.lastActiveAt || room.createdAt || 0;
    if (last < cutoff) { delete rooms[code]; removed++; }
  }
  if (removed) save();
  return removed;
}
setInterval(() => sweep(), 6 * 3600000).unref();
sweep();

export function roomCount() {
  return Object.keys(rooms).length;
}
