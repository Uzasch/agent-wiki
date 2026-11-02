// One shared run record per vault, so only one machine imports Wispr meetings per day.
// File `.agent-wiki/meetings.json` (tracked in git): { last_run, machine, last_meeting_start, claim_by, claim_at }.
//   last_run / machine   when the last import finished, and which machine did it
//   last_meeting_start   start of the newest meeting that import read: the next import reads from here
//   claim_by / claim_at  set while an import runs, so a second machine does not start at the same time
import fs from 'node:fs';
import path from 'node:path';
import { git } from './vault.mjs';
import { withLock } from './lock.mjs';

export const RUN_FILE = '.agent-wiki/meetings.json';
export const MIN_HOURS = 20;
export const CLAIM_STALE_MS = 2 * 3600_000;   // a claim older than this is a crashed run: take it
export const OVERLAP_MS = 86400_000;          // read one day before the newest meeting again: a late-edited meeting is re-read
const HOUR = 3600_000;
const TRIES = 4;
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export function readRun(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, RUN_FILE), 'utf8')) || {}; } catch { return {}; }
}

function writeRun(dir, rec) {
  const clean = Object.fromEntries(Object.entries(rec).filter(([, v]) => v !== undefined && v !== null));
  fs.mkdirSync(path.join(dir, path.dirname(RUN_FILE)), { recursive: true });
  fs.writeFileSync(path.join(dir, RUN_FILE), JSON.stringify(clean, null, 2) + '\n');
}

// Where the next import starts reading: the newest meeting of the last import, one day back. null = no record yet.
export function sinceFromRun(rec) {
  const t = Date.parse(rec?.last_meeting_start);
  return Number.isNaN(t) ? null : new Date(t - OVERLAP_MS).toISOString();
}

// ---------- git (same lock as syncVault's, so a sweep never interleaves) ----------
const isGit = (dir) => fs.existsSync(path.join(dir, '.git'));
const hasRemote = (dir) => git(dir, 'remote').out.trim().length > 0;

function underGitLock(dir, fn) {
  for (let i = 0; i < 30; i++) {
    const r = withLock(`git-${dir}`, fn, { staleMs: 10 * 60_000 });
    if (!r.locked) return r.value;
    sleepSync(2000);
  }
  return { ok: false, error: 'vault busy (another sync running)' };
}

function pull(dir) {
  if (!isGit(dir) || !hasRemote(dir)) return { ok: true };
  const r = git(dir, 'pull', '--rebase', '--autostash', '-q');
  if (r.ok) return { ok: true };
  git(dir, 'rebase', '--abort');
  return { ok: false, error: `pull failed: ${r.out.slice(0, 300)}` };
}

// Commit only the run file, then push. { ok } | { rejected } (someone pushed first) | { error }.
function commitPush(dir, message) {
  if (!isGit(dir)) return { ok: true };
  git(dir, 'add', '--', RUN_FILE);
  const c = git(dir, 'commit', '-q', '-m', message, '--', RUN_FILE);
  const committed = c.ok;
  if (!committed && !/nothing (added )?to commit|no changes added/i.test(c.out)) return { error: `commit failed: ${c.out.slice(0, 300)}` };
  if (!hasRemote(dir)) return { ok: true, committed };
  const p = git(dir, 'push', '-q');
  return p.ok ? { ok: true, committed } : { rejected: true, committed, out: p.out.slice(0, 300) };
}

// Take back our own run-file commit (not pushed), so a pull can bring in the other machine's version.
function undoCommit(dir) {
  git(dir, 'reset', '-q', '--soft', 'HEAD~1');
  if (git(dir, 'cat-file', '-e', `HEAD:${RUN_FILE}`).ok) git(dir, 'restore', '--staged', '--worktree', '--source=HEAD', '--', RUN_FILE);
  else { git(dir, 'rm', '-q', '-f', '--cached', '--', RUN_FILE); fs.rmSync(path.join(dir, RUN_FILE), { force: true }); }
}

// Why this machine must not import now, or null.
export function skipReason(rec, { machine, now, minHours, force, staleMs = CLAIM_STALE_MS }) {
  const claimAge = now - Date.parse(rec.claim_at);
  if (rec.claim_by && rec.claim_by !== machine && claimAge < staleMs) return `${rec.claim_by} is importing now (since ${rec.claim_at})`;
  if (!force && rec.last_run && now - Date.parse(rec.last_run) < minHours * HOUR) return `already imported by ${rec.machine || 'another machine'} at ${rec.last_run}`;
  return null;
}

// Pull the vault, check the record, write our claim and push it. If the push is rejected another machine
// was faster: pull and check again. Returns { ok, record } | { ok: false, skip } | { ok: false, error }.
// `beforeClaim` is a test seam: it runs after the record is read and before our claim is written.
export function claimRun(dir, { machine, minHours = MIN_HOURS, force = false, now = Date.now(), staleMs = CLAIM_STALE_MS, beforeClaim = () => {} }) {
  return underGitLock(dir, () => {
    for (let attempt = 1; attempt <= TRIES; attempt++) {
      const p = pull(dir);
      if (!p.ok) return p;
      const rec = readRun(dir);
      const skip = skipReason(rec, { machine, now, minHours, force, staleMs });
      if (skip) return { ok: false, skip };
      beforeClaim(attempt);
      writeRun(dir, { ...rec, claim_by: machine, claim_at: new Date(now).toISOString() });
      const r = commitPush(dir, `meetings: ${machine} starts the import`);
      if (r.ok) return { ok: true, record: rec };
      if (r.error) return { ok: false, error: r.error };
      if (r.committed) undoCommit(dir);   // rejected: loop pulls the other machine's record and checks again
    }
    return { ok: false, error: `could not claim the meetings import after ${TRIES} tries (the remote keeps changing)` };
  });
}

// After the import: `lastMeetingStart` (ISO, or null = keep the old one) and last_run are written and the claim cleared.
// With update:false (a partial run, or a failure) only our claim is cleared. A failed push of the final record stays
// committed locally, and the next sync pushes it.
export function finishRun(dir, { machine, now = Date.now(), lastMeetingStart = null, update = true }) {
  return underGitLock(dir, () => {
    for (let attempt = 1; attempt <= TRIES; attempt++) {
      const p = pull(dir);
      if (!p.ok) return p;
      const { claim_by, claim_at, ...rec } = readRun(dir);
      let next = rec;
      if (update) {
        const old = Date.parse(rec.last_meeting_start);
        const keep = lastMeetingStart && !(old > Date.parse(lastMeetingStart)) ? lastMeetingStart : rec.last_meeting_start;
        next = { last_run: new Date(now).toISOString(), machine, last_meeting_start: keep };
      } else if (claim_by && claim_by !== machine) next = { ...rec, claim_by, claim_at };   // not ours: leave it
      writeRun(dir, next);
      const r = commitPush(dir, update ? `meetings: ${machine} imported` : `meetings: ${machine} released the import`);
      if (r.ok) return { ok: true, record: next };
      if (r.error) return { ok: false, error: r.error };
      if (attempt === TRIES) return { ok: false, error: `push rejected, the run record stays committed locally: ${r.out}` };
      undoCommit(dir);
    }
    return { ok: false, error: 'unreachable' };
  });
}
