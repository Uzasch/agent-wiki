import { SCRATCH } from './setup.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeRemote, sh } from './fakes.mjs';
import { claimRun, finishRun, readRun, readRunOrLegacy, sinceFromRun, runFile, LEGACY_FILE, CLAIM_STALE_MS } from '../lib/meetingrun.mjs';

const HOUR = 3600_000;
const T0 = Date.parse('2026-11-02T08:00:00Z');
const iso = (ms) => new Date(ms).toISOString();
const U = 'ann';   // the one Wispr user of the older tests; the per-user tests at the end use more

// Two machines = two clones of one bare repo.
function twoMachines() {
  const r = makeRemote();
  return { a: r.clone('a'), b: r.clone('b'), bare: r.bare, clone: r.clone };
}
const remoteRun = (bare, user = U) => JSON.parse(sh('git', ['--git-dir', bare, 'show', `main:${runFile(user)}`]));
const commits = (dir) => sh('git', ['-C', dir, 'log', '--format=%s']).split('\n');

test('machine A claims and imports; machine B, a few hours later, skips', () => {
  const { a, b, bare } = twoMachines();
  const c = claimRun(a, { machine: 'machine-a', user: U, now: T0 });
  assert.equal(c.ok, true);
  assert.equal(remoteRun(bare).claim_by, 'machine-a', 'the claim is on the remote before the import starts');
  const f = finishRun(a, { machine: 'machine-a', user: U, now: T0 + 600_000, lastMeetingStart: '2026-11-01T15:00:00Z' });
  assert.equal(f.ok, true);
  assert.deepEqual(remoteRun(bare), { last_run: iso(T0 + 600_000), machine: 'machine-a', last_meeting_start: '2026-11-01T15:00:00Z' });

  const second = claimRun(b, { machine: 'machine-b', user: U, now: T0 + 3 * HOUR });
  assert.equal(second.ok, false);
  assert.match(second.skip, /^already imported by machine-a at 2026-11-02T08:10:00.000Z$/);
  assert.equal(readRun(b, U).machine, 'machine-a', 'B pulled A\'s record');
  assert.equal(sinceFromRun(readRun(b, U)), '2026-10-31T15:00:00.000Z', 'B would read from one day before the newest meeting');
});

test('after meetings_min_hours the next machine imports again; --force ignores the rule', () => {
  const { a, b } = twoMachines();
  claimRun(a, { machine: 'machine-a', user: U, now: T0 });
  finishRun(a, { machine: 'machine-a', user: U, now: T0, lastMeetingStart: '2026-11-01T15:00:00Z' });
  assert.ok(claimRun(b, { machine: 'machine-b', user: U, now: T0 + 19 * HOUR }).skip, '19 h: too early');
  const forced = claimRun(b, { machine: 'machine-b', user: U, now: T0 + 1 * HOUR, force: true });
  assert.equal(forced.ok, true, '--force');
  finishRun(b, { machine: 'machine-b', user: U, update: false });
  assert.equal(claimRun(b, { machine: 'machine-b', user: U, now: T0 + 21 * HOUR }).ok, true, '21 h: allowed');
  finishRun(b, { machine: 'machine-b', user: U, update: false });
  assert.equal(claimRun(a, { machine: 'machine-a', user: U, now: T0 + 5 * HOUR, minHours: 4, force: false }).ok, true, 'a smaller meetings_min_hours');
});

test('a fresh claim by another machine blocks, even with --force; a stale one (over 2 h) is taken', () => {
  const { a, b, bare } = twoMachines();
  claimRun(a, { machine: 'machine-a', user: U, now: T0 });                        // A starts and never finishes
  const fresh = claimRun(b, { machine: 'machine-b', user: U, now: T0 + 30 * 60_000, force: true });
  assert.match(fresh.skip, /^machine-a is importing now \(since 2026-11-02T08:00:00.000Z\)$/);
  const stale = claimRun(b, { machine: 'machine-b', user: U, now: T0 + CLAIM_STALE_MS + 60_000 });
  assert.equal(stale.ok, true, 'stale claim taken');
  assert.equal(remoteRun(bare).claim_by, 'machine-b');
  finishRun(b, { machine: 'machine-b', user: U, now: T0 + 3 * HOUR, lastMeetingStart: '2026-11-02T07:00:00Z' });
  const r = remoteRun(bare);
  assert.equal(r.machine, 'machine-b');
  assert.equal(r.claim_by, undefined, 'claim cleared');
});

test('a claim of this same machine (a crashed earlier run) is taken at once', () => {
  const { a } = twoMachines();
  claimRun(a, { machine: 'machine-a', user: U, now: T0 });
  assert.equal(claimRun(a, { machine: 'machine-a', user: U, now: T0 + 60_000 }).ok, true);
});

test('push race: both read the record, A pushes its claim first, B is rejected, pulls and skips', () => {
  const { a, b, bare } = twoMachines();
  const bCommitsBefore = commits(b).length;
  const r = claimRun(b, {
    machine: 'machine-b', user: U, now: T0 + 1000,
    beforeClaim: (attempt) => { if (attempt === 1) assert.equal(claimRun(a, { machine: 'machine-a', user: U, now: T0 }).ok, true); },
  });
  assert.equal(r.ok, false);
  assert.match(r.skip, /^machine-a is importing now/);
  assert.equal(remoteRun(bare).claim_by, 'machine-a', 'the winner\'s claim stands');
  assert.ok(!commits(b).some((s) => /machine-b starts/.test(s)), 'the loser\'s claim commit was taken back');
  assert.equal(readRun(b, U).claim_by, 'machine-a');
  assert.ok(commits(b).length >= bCommitsBefore);
});

test('push race with an unrelated commit on the remote: B is rejected, pulls, sees no claim, and claims on the second try', () => {
  const { a, b, bare } = twoMachines();
  const attempts = [];
  const r = claimRun(b, {
    machine: 'machine-b', user: U, now: T0,
    beforeClaim: (attempt) => {
      attempts.push(attempt);
      if (attempt === 1) {   // a session page lands on the remote meanwhile
        fs.writeFileSync(path.join(a, 'note.md'), 'x\n');
        sh('git', ['-C', a, 'add', '-A']); sh('git', ['-C', a, 'commit', '-q', '-m', 'session']); sh('git', ['-C', a, 'push', '-q']);
      }
    },
  });
  assert.equal(r.ok, true);
  assert.deepEqual(attempts, [1, 2]);
  assert.equal(remoteRun(bare).claim_by, 'machine-b');
});

test('finishRun keeps local unpushed commits and never moves the reading point back', () => {
  const { a, bare } = twoMachines();
  claimRun(a, { machine: 'machine-a', user: U, now: T0 });
  finishRun(a, { machine: 'machine-a', user: U, now: T0, lastMeetingStart: '2026-11-01T15:00:00Z' });
  fs.writeFileSync(path.join(a, 'local.md'), 'unpushed\n');
  sh('git', ['-C', a, 'add', '-A']); sh('git', ['-C', a, 'commit', '-q', '-m', 'local only']);
  claimRun(a, { machine: 'machine-a', user: U, now: T0 + 25 * HOUR });
  finishRun(a, { machine: 'machine-a', user: U, now: T0 + 25 * HOUR, lastMeetingStart: '2026-10-01T00:00:00Z' });
  assert.equal(remoteRun(bare).last_meeting_start, '2026-11-01T15:00:00Z');
  assert.equal(sh('git', ['--git-dir', bare, 'show', 'main:local.md']), 'unpushed', 'the local commit went along');
  finishRun(a, { machine: 'machine-a', user: U, now: T0 + 26 * HOUR, lastMeetingStart: null });
  assert.equal(remoteRun(bare).last_meeting_start, '2026-11-01T15:00:00Z', 'no meeting read: keep the old point');
});

test('a failed or partial run only clears the claim: last_run stays, so another machine may import', () => {
  const { a, b, bare } = twoMachines();
  claimRun(a, { machine: 'machine-a', user: U, now: T0 });
  finishRun(a, { machine: 'machine-a', user: U, update: false });
  const rec = remoteRun(bare);
  assert.equal(rec.claim_by, undefined);
  assert.equal(rec.last_run, undefined);
  assert.equal(claimRun(b, { machine: 'machine-b', user: U, now: T0 + 60_000 }).ok, true);
});

test('releasing never clears another machine\'s claim', () => {
  const { a, b, bare } = twoMachines();
  claimRun(a, { machine: 'machine-a', user: U, now: T0 });                        // A is slow...
  claimRun(b, { machine: 'machine-b', user: U, now: T0 + CLAIM_STALE_MS + 60_000 });   // ...B takes the stale claim
  finishRun(a, { machine: 'machine-a', user: U, update: false });                 // A fails late
  assert.equal(remoteRun(bare).claim_by, 'machine-b');
});

test('a vault without git or without a remote works on its own', () => {
  const plain = path.join(SCRATCH, 'plain-vault');
  fs.mkdirSync(plain, { recursive: true });
  assert.equal(claimRun(plain, { machine: 'solo', user: U, now: T0 }).ok, true);
  assert.equal(finishRun(plain, { machine: 'solo', user: U, now: T0, lastMeetingStart: '2026-11-01T00:00:00Z' }).ok, true);
  assert.match(claimRun(plain, { machine: 'solo', user: U, now: T0 + HOUR }).skip, /already imported by solo/);

  const local = path.join(SCRATCH, 'local-git-vault');
  fs.mkdirSync(local, { recursive: true });
  sh('git', ['-C', local, 'init', '-q', '-b', 'main']);
  assert.equal(claimRun(local, { machine: 'solo', user: U, now: T0 }).ok, true);
  assert.equal(finishRun(local, { machine: 'solo', user: U, now: T0 }).ok, true);
  assert.equal(readRun(local, U).machine, 'solo');
});

// ---------- one record per Wispr user ----------
const LEGACY = { last_run: iso(T0), machine: 'old-machine', last_meeting_start: '2026-11-01T15:00:00Z' };
// An older vault: one shared record for everybody, committed and pushed from clone `from`.
function seedLegacy(from, rec = LEGACY) {
  fs.mkdirSync(path.join(from, '.agent-wiki'), { recursive: true });
  fs.writeFileSync(path.join(from, LEGACY_FILE), JSON.stringify(rec, null, 2) + '\n');
  sh('git', ['-C', from, 'add', '-A']); sh('git', ['-C', from, 'commit', '-q', '-m', 'old shared record']); sh('git', ['-C', from, 'push', '-q']);
}
const remoteFiles = (bare) => sh('git', ['--git-dir', bare, 'ls-tree', '-r', '--name-only', 'main']).split('\n');

test('per user: Ann imports; Bob (another user) is not blocked; Ann\'s second machine is', () => {
  const { a, b, clone, bare } = twoMachines();
  const a2 = clone('a2');
  claimRun(a, { machine: 'ann-pc', user: 'ann', now: T0 });
  assert.equal(finishRun(a, { machine: 'ann-pc', user: 'ann', now: T0 + 600_000, lastMeetingStart: '2026-11-01T15:00:00Z' }).ok, true);

  const bob = claimRun(b, { machine: 'bob-pc', user: 'bob', now: T0 + 3 * HOUR });
  assert.equal(bob.ok, true, 'Ann\'s import does not block Bob');
  assert.equal(bob.record.last_run, undefined, 'Bob starts with no record of his own');
  finishRun(b, { machine: 'bob-pc', user: 'bob', now: T0 + 3 * HOUR + 600_000, lastMeetingStart: '2026-11-02T01:00:00Z' });

  const second = claimRun(a2, { machine: 'ann-laptop', user: 'ann', now: T0 + 4 * HOUR });
  assert.match(second.skip, /^already imported by ann-pc at 2026-11-02T08:10:00.000Z$/, 'a second machine of the same user skips');

  assert.deepEqual(remoteFiles(bare).filter((f) => f.startsWith('.agent-wiki/')), ['.agent-wiki/meetings/ann.json', '.agent-wiki/meetings/bob.json']);
  assert.equal(remoteRun(bare, 'ann').machine, 'ann-pc');
  assert.equal(remoteRun(bare, 'bob').machine, 'bob-pc');
  assert.equal(remoteRun(bare, 'ann').last_meeting_start, '2026-11-01T15:00:00Z', 'Bob\'s import did not touch Ann\'s reading point');
});

test('per user: Ann\'s claim in progress does not block Bob, but blocks Ann\'s other machine', () => {
  const { a, b, clone } = twoMachines();
  const a2 = clone('a2');
  claimRun(a, { machine: 'ann-pc', user: 'ann', now: T0 });
  assert.equal(claimRun(b, { machine: 'bob-pc', user: 'bob', now: T0 + 60_000, force: true }).ok, true);
  assert.match(claimRun(a2, { machine: 'ann-laptop', user: 'ann', now: T0 + 60_000 }).skip, /^ann-pc is importing now/);
});

test('per user push race: Ann pushes her claim while Bob is claiming; Bob is rejected, pulls, and claims on the second try', () => {
  const { a, b, bare } = twoMachines();
  const attempts = [];
  const r = claimRun(b, {
    machine: 'bob-pc', user: 'bob', now: T0,
    beforeClaim: (attempt) => { attempts.push(attempt); if (attempt === 1) assert.equal(claimRun(a, { machine: 'ann-pc', user: 'ann', now: T0 }).ok, true); },
  });
  assert.equal(r.ok, true, 'the other user\'s claim is no reason to skip');
  assert.deepEqual(attempts, [1, 2]);
  assert.equal(remoteRun(bare, 'ann').claim_by, 'ann-pc');
  assert.equal(remoteRun(bare, 'bob').claim_by, 'bob-pc');
});

test('the file name comes from a slug: no user can write outside the record folder', () => {
  assert.equal(runFile('ann'), '.agent-wiki/meetings/ann.json');
  assert.equal(runFile('../../Ann Lee@example.org'), '.agent-wiki/meetings/ann-lee-example-org.json');
  assert.throws(() => runFile(''), /no user name/);
  assert.throws(() => runFile('///'), /no user name/);
});

test('migration: the old shared record moves to the first user that runs, in the same commit as the claim; the old file is gone', () => {
  const { a, b, bare } = twoMachines();
  seedLegacy(a);
  const r = claimRun(b, { machine: 'ann-pc', user: 'ann', now: T0 + 25 * HOUR });
  assert.equal(r.ok, true);
  assert.deepEqual(r.record, LEGACY, 'the import starts from the old record: same reading point');
  assert.deepEqual(remoteFiles(bare).filter((f) => f.startsWith('.agent-wiki/')), ['.agent-wiki/meetings/ann.json']);
  const rec = remoteRun(bare, 'ann');
  assert.equal(rec.last_meeting_start, LEGACY.last_meeting_start);
  assert.equal(rec.last_run, LEGACY.last_run);
  assert.equal(rec.claim_by, 'ann-pc');
  const changes = sh('git', ['--git-dir', bare, 'show', '--name-status', '--format=%s', 'main']).split('\n').filter(Boolean);
  assert.match(changes[0], /^meetings: ann-pc starts the import \(ann takes over the shared record\)$/);
  assert.deepEqual(changes.slice(1).sort(), ['A\t.agent-wiki/meetings/ann.json', 'D\t.agent-wiki/meetings.json'], 'one commit: new file added, old file removed');
});

test('migration also happens when the answer is "skip" (the old record is recent): the user owns it, and the next user is not blocked by it', () => {
  const { a, b, clone, bare } = twoMachines();
  seedLegacy(a, { ...LEGACY, last_run: iso(T0 + 2 * HOUR) });
  const ann = claimRun(b, { machine: 'ann-pc', user: 'ann', now: T0 + 3 * HOUR });
  assert.match(ann.skip, /^already imported by old-machine at/);
  assert.deepEqual(remoteFiles(bare).filter((f) => f.startsWith('.agent-wiki/')), ['.agent-wiki/meetings/ann.json'], 'moved and pushed even though she skipped');
  assert.equal(remoteRun(bare, 'ann').last_run, iso(T0 + 2 * HOUR));
  const bob = claimRun(clone('c'), { machine: 'bob-pc', user: 'bob', now: T0 + 3 * HOUR });
  assert.equal(bob.ok, true, 'Bob finds no old record to inherit');
  assert.equal(bob.record.last_run, undefined);
});

test('migration waits for an old-format import that is running now: nothing moves, the user skips', () => {
  const { a, b, bare } = twoMachines();
  seedLegacy(a, { ...LEGACY, last_run: undefined, claim_by: 'old-machine', claim_at: iso(T0) });
  const r = claimRun(b, { machine: 'ann-pc', user: 'ann', now: T0 + 30 * 60_000, force: true });
  assert.match(r.skip, /^old-machine is importing now/);
  assert.deepEqual(remoteFiles(bare).filter((f) => f.startsWith('.agent-wiki/')), ['.agent-wiki/meetings.json'], 'the old file stays for the running import to finish');
  const late = claimRun(b, { machine: 'ann-pc', user: 'ann', now: T0 + CLAIM_STALE_MS + 60_000 });   // the old run crashed: its claim is stale
  assert.equal(late.ok, true);
});

test('the old record is never deleted when the user already has a file of her own', () => {
  const { a, b, bare } = twoMachines();
  claimRun(a, { machine: 'ann-pc', user: 'ann', now: T0 });
  finishRun(a, { machine: 'ann-pc', user: 'ann', now: T0, lastMeetingStart: '2026-11-01T15:00:00Z' });
  seedLegacy(a);   // an old-format machine pushes the shared record later
  assert.ok(claimRun(a, { machine: 'ann-pc', user: 'ann', now: T0 + 25 * HOUR }).ok);
  assert.ok(remoteFiles(bare).includes(LEGACY_FILE), 'still there: it belongs to whoever has no file yet');
  assert.equal(remoteRun(bare, 'ann').last_meeting_start, '2026-11-01T15:00:00Z', 'her own record was used, not the old one');
  assert.ok(b);
});

test('a read-only look (--dry-run, status) uses the old record when the user has none, and moves nothing', () => {
  const { a, bare } = twoMachines();
  seedLegacy(a);
  assert.deepEqual(readRun(a, 'ann'), {});
  assert.deepEqual(readRunOrLegacy(a, 'ann'), LEGACY);
  assert.ok(fs.existsSync(path.join(a, LEGACY_FILE)));
  assert.ok(remoteFiles(bare).includes(LEGACY_FILE));
});

test('migration in a vault without git', () => {
  const plain = path.join(SCRATCH, 'plain-legacy-vault');
  fs.mkdirSync(path.join(plain, '.agent-wiki'), { recursive: true });
  fs.writeFileSync(path.join(plain, LEGACY_FILE), JSON.stringify(LEGACY));
  assert.equal(claimRun(plain, { machine: 'solo', user: 'ann', now: T0 + 25 * HOUR }).ok, true);
  assert.ok(!fs.existsSync(path.join(plain, LEGACY_FILE)));
  assert.equal(readRun(plain, 'ann').last_meeting_start, LEGACY.last_meeting_start);
});

test('migration push race: Bob takes the old record first; Ann is rejected, her half-done move is taken back, and she claims a fresh record', () => {
  const { a, b, bare } = twoMachines();
  seedLegacy(a);
  sh('git', ['-C', b, 'pull', '-q', '--rebase']);
  const r = claimRun(b, {
    machine: 'ann-pc', user: 'ann', now: T0 + 25 * HOUR,
    beforeClaim: (attempt) => { if (attempt === 1) assert.equal(claimRun(a, { machine: 'bob-pc', user: 'bob', now: T0 + 25 * HOUR }).ok, true); },
  });
  assert.equal(r.ok, true);
  assert.equal(r.record.last_run, undefined, 'Ann got no old record: Bob already took it');
  assert.equal(remoteRun(bare, 'bob').last_meeting_start, LEGACY.last_meeting_start);
  assert.equal(remoteRun(bare, 'ann').claim_by, 'ann-pc');
  assert.ok(!remoteFiles(bare).includes(LEGACY_FILE));
  assert.equal(sh('git', ['-C', b, 'status', '--porcelain']), '', 'no stray changes left in Ann\'s clone');
});
