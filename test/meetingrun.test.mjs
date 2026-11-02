import { SCRATCH } from './setup.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeRemote, sh } from './fakes.mjs';
import { claimRun, finishRun, readRun, sinceFromRun, RUN_FILE, CLAIM_STALE_MS } from '../lib/meetingrun.mjs';

const HOUR = 3600_000;
const T0 = Date.parse('2026-11-02T08:00:00Z');
const iso = (ms) => new Date(ms).toISOString();

// Two machines = two clones of one bare repo.
function twoMachines() {
  const r = makeRemote();
  return { a: r.clone('a'), b: r.clone('b'), bare: r.bare, clone: r.clone };
}
const remoteRun = (bare) => JSON.parse(sh('git', ['--git-dir', bare, 'show', `main:${RUN_FILE}`]));
const commits = (dir) => sh('git', ['-C', dir, 'log', '--format=%s']).split('\n');

test('machine A claims and imports; machine B, a few hours later, skips', () => {
  const { a, b, bare } = twoMachines();
  const c = claimRun(a, { machine: 'machine-a', now: T0 });
  assert.equal(c.ok, true);
  assert.equal(remoteRun(bare).claim_by, 'machine-a', 'the claim is on the remote before the import starts');
  const f = finishRun(a, { machine: 'machine-a', now: T0 + 600_000, lastMeetingStart: '2026-11-01T15:00:00Z' });
  assert.equal(f.ok, true);
  assert.deepEqual(remoteRun(bare), { last_run: iso(T0 + 600_000), machine: 'machine-a', last_meeting_start: '2026-11-01T15:00:00Z' });

  const second = claimRun(b, { machine: 'machine-b', now: T0 + 3 * HOUR });
  assert.equal(second.ok, false);
  assert.match(second.skip, /^already imported by machine-a at 2026-11-02T08:10:00.000Z$/);
  assert.equal(readRun(b).machine, 'machine-a', 'B pulled A\'s record');
  assert.equal(sinceFromRun(readRun(b)), '2026-10-31T15:00:00.000Z', 'B would read from one day before the newest meeting');
});

test('after meetings_min_hours the next machine imports again; --force ignores the rule', () => {
  const { a, b } = twoMachines();
  claimRun(a, { machine: 'machine-a', now: T0 });
  finishRun(a, { machine: 'machine-a', now: T0, lastMeetingStart: '2026-11-01T15:00:00Z' });
  assert.ok(claimRun(b, { machine: 'machine-b', now: T0 + 19 * HOUR }).skip, '19 h: too early');
  const forced = claimRun(b, { machine: 'machine-b', now: T0 + 1 * HOUR, force: true });
  assert.equal(forced.ok, true, '--force');
  finishRun(b, { machine: 'machine-b', update: false });
  assert.equal(claimRun(b, { machine: 'machine-b', now: T0 + 21 * HOUR }).ok, true, '21 h: allowed');
  finishRun(b, { machine: 'machine-b', update: false });
  assert.equal(claimRun(a, { machine: 'machine-a', now: T0 + 5 * HOUR, minHours: 4, force: false }).ok, true, 'a smaller meetings_min_hours');
});

test('a fresh claim by another machine blocks, even with --force; a stale one (over 2 h) is taken', () => {
  const { a, b, bare } = twoMachines();
  claimRun(a, { machine: 'machine-a', now: T0 });                        // A starts and never finishes
  const fresh = claimRun(b, { machine: 'machine-b', now: T0 + 30 * 60_000, force: true });
  assert.match(fresh.skip, /^machine-a is importing now \(since 2026-11-02T08:00:00.000Z\)$/);
  const stale = claimRun(b, { machine: 'machine-b', now: T0 + CLAIM_STALE_MS + 60_000 });
  assert.equal(stale.ok, true, 'stale claim taken');
  assert.equal(remoteRun(bare).claim_by, 'machine-b');
  finishRun(b, { machine: 'machine-b', now: T0 + 3 * HOUR, lastMeetingStart: '2026-11-02T07:00:00Z' });
  const r = remoteRun(bare);
  assert.equal(r.machine, 'machine-b');
  assert.equal(r.claim_by, undefined, 'claim cleared');
});

test('a claim of this same machine (a crashed earlier run) is taken at once', () => {
  const { a } = twoMachines();
  claimRun(a, { machine: 'machine-a', now: T0 });
  assert.equal(claimRun(a, { machine: 'machine-a', now: T0 + 60_000 }).ok, true);
});

test('push race: both read the record, A pushes its claim first, B is rejected, pulls and skips', () => {
  const { a, b, bare } = twoMachines();
  const bCommitsBefore = commits(b).length;
  const r = claimRun(b, {
    machine: 'machine-b', now: T0 + 1000,
    beforeClaim: (attempt) => { if (attempt === 1) assert.equal(claimRun(a, { machine: 'machine-a', now: T0 }).ok, true); },
  });
  assert.equal(r.ok, false);
  assert.match(r.skip, /^machine-a is importing now/);
  assert.equal(remoteRun(bare).claim_by, 'machine-a', 'the winner\'s claim stands');
  assert.ok(!commits(b).some((s) => /machine-b starts/.test(s)), 'the loser\'s claim commit was taken back');
  assert.equal(readRun(b).claim_by, 'machine-a');
  assert.ok(commits(b).length >= bCommitsBefore);
});

test('push race with an unrelated commit on the remote: B is rejected, pulls, sees no claim, and claims on the second try', () => {
  const { a, b, bare } = twoMachines();
  const attempts = [];
  const r = claimRun(b, {
    machine: 'machine-b', now: T0,
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
  claimRun(a, { machine: 'machine-a', now: T0 });
  finishRun(a, { machine: 'machine-a', now: T0, lastMeetingStart: '2026-11-01T15:00:00Z' });
  fs.writeFileSync(path.join(a, 'local.md'), 'unpushed\n');
  sh('git', ['-C', a, 'add', '-A']); sh('git', ['-C', a, 'commit', '-q', '-m', 'local only']);
  claimRun(a, { machine: 'machine-a', now: T0 + 25 * HOUR });
  finishRun(a, { machine: 'machine-a', now: T0 + 25 * HOUR, lastMeetingStart: '2026-10-01T00:00:00Z' });
  assert.equal(remoteRun(bare).last_meeting_start, '2026-11-01T15:00:00Z');
  assert.equal(sh('git', ['--git-dir', bare, 'show', 'main:local.md']), 'unpushed', 'the local commit went along');
  finishRun(a, { machine: 'machine-a', now: T0 + 26 * HOUR, lastMeetingStart: null });
  assert.equal(remoteRun(bare).last_meeting_start, '2026-11-01T15:00:00Z', 'no meeting read: keep the old point');
});

test('a failed or partial run only clears the claim: last_run stays, so another machine may import', () => {
  const { a, b, bare } = twoMachines();
  claimRun(a, { machine: 'machine-a', now: T0 });
  finishRun(a, { machine: 'machine-a', update: false });
  const rec = remoteRun(bare);
  assert.equal(rec.claim_by, undefined);
  assert.equal(rec.last_run, undefined);
  assert.equal(claimRun(b, { machine: 'machine-b', now: T0 + 60_000 }).ok, true);
});

test('releasing never clears another machine\'s claim', () => {
  const { a, b, bare } = twoMachines();
  claimRun(a, { machine: 'machine-a', now: T0 });                        // A is slow...
  claimRun(b, { machine: 'machine-b', now: T0 + CLAIM_STALE_MS + 60_000 });   // ...B takes the stale claim
  finishRun(a, { machine: 'machine-a', update: false });                 // A fails late
  assert.equal(remoteRun(bare).claim_by, 'machine-b');
});

test('a vault without git or without a remote works on its own', () => {
  const plain = path.join(SCRATCH, 'plain-vault');
  fs.mkdirSync(plain, { recursive: true });
  assert.equal(claimRun(plain, { machine: 'solo', now: T0 }).ok, true);
  assert.equal(finishRun(plain, { machine: 'solo', now: T0, lastMeetingStart: '2026-11-01T00:00:00Z' }).ok, true);
  assert.match(claimRun(plain, { machine: 'solo', now: T0 + HOUR }).skip, /already imported by solo/);

  const local = path.join(SCRATCH, 'local-git-vault');
  fs.mkdirSync(local, { recursive: true });
  sh('git', ['-C', local, 'init', '-q', '-b', 'main']);
  assert.equal(claimRun(local, { machine: 'solo', now: T0 }).ok, true);
  assert.equal(finishRun(local, { machine: 'solo', now: T0 }).ok, true);
  assert.equal(readRun(local).machine, 'solo');
});
