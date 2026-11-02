// One run record per Wispr user in the vault, so each person's meetings are imported once a day, by whichever
// of THAT person's machines runs first. Two people never block each other; two machines of one person do.
// File `.agent-wiki/meetings/<user>.json` (tracked in git): { last_run, machine, last_meeting_start, claim_by, claim_at }.
//   last_run / machine   when the last import finished, and which machine did it
//   last_meeting_start   start of the newest meeting that import read: the next import reads from here
//   claim_by / claim_at  set while an import runs, so a second machine does not start at the same time
// Older vaults have ONE record `.agent-wiki/meetings.json` for everybody: the first user to run takes it over.
import fs from 'node:fs';
import path from 'node:path';
import { git } from './vault.mjs';
import { withLock } from './lock.mjs';
import { userSlug } from './wispr.mjs';

export const RUN_DIR = '.agent-wiki/meetings';
export const LEGACY_FILE = '.agent-wiki/meetings.json';
export const MIN_HOURS = 20;
export const CLAIM_STALE_MS = 2 * 3600_000;   // a claim older than this is a crashed run: take it
export const OVERLAP_MS = 86400_000;          // read one day before the newest meeting again: a late-edited meeting is re-read
const HOUR = 3600_000;
const TRIES = 4;
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// Vault-relative path of one user's record. The name is slugged again here, so it can never leave the folder.
export function runFile(user) {
  const slug = userSlug(user);
  if (!slug) throw new Error('meetings run record: no user name');
  return `${RUN_DIR}/${slug}.json`;
}

const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch { return {}; } };

// The user's own record ({} if none).
export function readRun(dir, user) {
  return readJson(path.join(dir, runFile(user)));
}

// For a read-only look (--dry-run, status): the user's record, else the old shared one.
export function readRunOrLegacy(dir, user) {
  const mine = path.join(dir, runFile(user));
  return readJson(fs.existsSync(mine) || !fs.existsSync(path.join(dir, LEGACY_FILE)) ? mine : path.join(dir, LEGACY_FILE));
}

function writeRun(dir, user, rec) {
  const clean = Object.fromEntries(Object.entries(rec).filter(([, v]) => v !== undefined && v !== null));
  const file = path.join(dir, runFile(user));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(clean, null, 2) + '\n');
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

// Commit only the given record files, then push. { ok } | { rejected } (someone pushed first) | { error }.
function commitPush(dir, message, files) {
  if (!isGit(dir)) return { ok: true };
  const there = files.filter((f) => fs.existsSync(path.join(dir, f)));   // a removed file is already staged by `git rm`
  if (there.length) git(dir, 'add', '--', ...there);
  const c = git(dir, 'commit', '-q', '-m', message, '--', ...files);
  const committed = c.ok;
  if (!committed && !/nothing (added )?to commit|no changes added/i.test(c.out)) return { error: `commit failed: ${c.out.slice(0, 300)}` };
  if (!hasRemote(dir)) return { ok: true, committed };
  const p = git(dir, 'push', '-q');
  return p.ok ? { ok: true, committed } : { rejected: true, committed, out: p.out.slice(0, 300) };
}

// Take back our own record commit (not pushed), so a pull can bring in the other machine's version.
function undoCommit(dir, files) {
  git(dir, 'reset', '-q', '--soft', 'HEAD~1');
  for (const f of files) {
    if (git(dir, 'cat-file', '-e', `HEAD:${f}`).ok) git(dir, 'restore', '--staged', '--worktree', '--source=HEAD', '--', f);
    else { git(dir, 'rm', '-q', '-f', '--cached', '--ignore-unmatch', '--', f); fs.rmSync(path.join(dir, f), { force: true }); }
  }
}

// ---------- the old shared record ----------
// It applies when it exists and this user has no record yet. Returns its content, or null.
function legacyFor(dir, user) {
  const old = path.join(dir, LEGACY_FILE);
  if (!fs.existsSync(old) || fs.existsSync(path.join(dir, runFile(user)))) return null;
  return readJson(old);
}

// Move the old record to this user's file and remove the old one (git rm). Returns the files the commit must name.
function moveLegacy(dir, user) {
  const mine = path.join(dir, runFile(user));
  fs.mkdirSync(path.dirname(mine), { recursive: true });
  fs.copyFileSync(path.join(dir, LEGACY_FILE), mine);   // byte for byte, whatever it holds
  const tracked = isGit(dir) && git(dir, 'ls-files', '--error-unmatch', '--', LEGACY_FILE).ok;
  if (tracked) git(dir, 'rm', '-q', '-f', '--', LEGACY_FILE); else fs.rmSync(path.join(dir, LEGACY_FILE), { force: true });
  return tracked ? [runFile(user), LEGACY_FILE] : [runFile(user)];
}

// Why this machine must not import now, or null.
export function skipReason(rec, { machine, now, minHours, force, staleMs = CLAIM_STALE_MS }) {
  const claimAge = now - Date.parse(rec.claim_at);
  if (rec.claim_by && rec.claim_by !== machine && claimAge < staleMs) return `${rec.claim_by} is importing now (since ${rec.claim_at})`;
  if (!force && rec.last_run && now - Date.parse(rec.last_run) < minHours * HOUR) return `already imported by ${rec.machine || 'another machine'} at ${rec.last_run}`;
  return null;
}

// Pull the vault, check the user's record, write our claim and push it. If the push is rejected another machine
// was faster: pull and check again. Returns { ok, record } | { ok: false, skip } | { ok: false, error }.
// The old shared record moves to this user in the same commit (also when the answer is "skip", so the next user does not inherit it);
// a fresh claim in it (an old-format import running now) is waited for: nothing moves, the answer is "skip".
// `beforeClaim` is a test seam: it runs after the record is read and before our claim is written.
export function claimRun(dir, { machine, user, minHours = MIN_HOURS, force = false, now = Date.now(), staleMs = CLAIM_STALE_MS, beforeClaim = () => {} }) {
  const file = runFile(user);
  const who = userSlug(user);
  return underGitLock(dir, () => {
    for (let attempt = 1; attempt <= TRIES; attempt++) {
      const p = pull(dir);
      if (!p.ok) return p;
      const old = legacyFor(dir, user);
      if (old) {
        const busy = skipReason(old, { machine, now, minHours, force: true, staleMs });   // force: only the claim rule
        if (busy) return { ok: false, skip: busy };
      }
      const moved = old ? moveLegacy(dir, user) : [];
      const rec = readRun(dir, user);
      const skip = skipReason(rec, { machine, now, minHours, force, staleMs });
      if (skip) {
        if (!moved.length) return { ok: false, skip };
        const r = commitPush(dir, `meetings: ${who} takes over the shared record`, moved);
        if (r.error) return { ok: false, error: r.error };
        if (r.ok) return { ok: false, skip };
        if (r.committed) undoCommit(dir, moved);
        continue;
      }
      beforeClaim(attempt);
      writeRun(dir, user, { ...rec, claim_by: machine, claim_at: new Date(now).toISOString() });
      const files = [...new Set([file, ...moved])];
      const r = commitPush(dir, `meetings: ${machine} starts the import${moved.length ? ` (${who} takes over the shared record)` : ''}`, files);
      if (r.ok) return { ok: true, record: rec };
      if (r.error) return { ok: false, error: r.error };
      if (r.committed) undoCommit(dir, files);   // rejected: loop pulls the other machine's record and checks again
    }
    return { ok: false, error: `could not claim the meetings import after ${TRIES} tries (the remote keeps changing)` };
  });
}

// After the import: `lastMeetingStart` (ISO, or null = keep the old one) and last_run are written and the claim cleared.
// With update:false (a partial run, or a failure) only our claim is cleared. A failed push of the final record stays
// committed locally, and the next sync pushes it.
export function finishRun(dir, { machine, user, now = Date.now(), lastMeetingStart = null, update = true }) {
  const file = runFile(user);
  return underGitLock(dir, () => {
    for (let attempt = 1; attempt <= TRIES; attempt++) {
      const p = pull(dir);
      if (!p.ok) return p;
      const { claim_by, claim_at, ...rec } = readRun(dir, user);
      let next = rec;
      if (update) {
        const old = Date.parse(rec.last_meeting_start);
        const keep = lastMeetingStart && !(old > Date.parse(lastMeetingStart)) ? lastMeetingStart : rec.last_meeting_start;
        next = { last_run: new Date(now).toISOString(), machine, last_meeting_start: keep };
      } else if (claim_by && claim_by !== machine) next = { ...rec, claim_by, claim_at };   // not ours: leave it
      writeRun(dir, user, next);
      const r = commitPush(dir, update ? `meetings: ${machine} imported` : `meetings: ${machine} released the import`, [file]);
      if (r.ok) return { ok: true, record: next };
      if (r.error) return { ok: false, error: r.error };
      if (attempt === TRIES) return { ok: false, error: `push rejected, the run record stays committed locally: ${r.out}` };
      undoCommit(dir, [file]);
    }
    return { ok: false, error: 'unreachable' };
  });
}
