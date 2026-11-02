// mkdir-based lock (atomic on one machine). Stale after `staleMs`.
import fs from 'node:fs';
import path from 'node:path';
import { STATE_DIR } from './config.mjs';

export function withLock(name, fn, { staleMs = 5 * 60_000 } = {}) {
  const dir = path.join(STATE_DIR, 'locks', name.replace(/[^\w.-]/g, '_'));
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  try {
    fs.mkdirSync(dir);
  } catch {
    const age = Date.now() - fs.statSync(dir).mtimeMs;
    if (age < staleMs) return { locked: true };
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir);
  }
  try {
    return { locked: false, value: fn() };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Same lock for an async function: it is held until the returned promise settles.
export async function withLockAsync(name, fn, { staleMs = 5 * 60_000 } = {}) {
  const dir = path.join(STATE_DIR, 'locks', name.replace(/[^\w.-]/g, '_'));
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  try {
    fs.mkdirSync(dir);
  } catch {
    const age = Date.now() - fs.statSync(dir).mtimeMs;
    if (age < staleMs) return { locked: true };
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir);
  }
  try {
    return { locked: false, value: await fn() };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
