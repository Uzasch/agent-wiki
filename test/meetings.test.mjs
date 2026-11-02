import { SCRATCH, mk, write } from './setup.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fetchMeetings, isNotReady } from '../lib/meetings.mjs';

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'agent-wiki.mjs');
const NOT_READY = 'no JSON in reply: The Wispr Flow server is still connecting, search_meetings isn\'t available';
const detail = { id: 'm1', title: 'Sync', start: '2026-03-01T10:00:00Z', summary: 'We talked.' };

test('isNotReady recognises a connector that is still starting', () => {
  assert.ok(isNotReady(NOT_READY));
  assert.ok(isNotReady('the tool is not available right now'));
  assert.ok(!isNotReady('bad json from claude'));
});

function fake(script) {
  const calls = [];
  const ask = (prompt) => { calls.push(prompt); const r = script.shift(); return typeof r === 'function' ? r(prompt) : r; };
  return { ask, calls };
}

test('the list call is retried (with waits) while the connector is not ready, then works', () => {
  const sleeps = [];
  const { ask, calls } = fake([{ error: NOT_READY, cost: 0.01 }, { error: NOT_READY, cost: 0.01 }, { json: [{ id: 'm1', title: 'Sync', start: '2026-03-01T10:00:00Z' }], cost: 0.01 }, { json: detail, cost: 0.02 }]);
  const logs = [];
  const r = fetchMeetings({ ask, sleep: (ms) => sleeps.push(ms), gapMs: 45_000, onError: (m) => logs.push(m) });
  assert.equal(r.meetings.length, 1);
  assert.deepEqual(sleeps, [45_000, 45_000]);
  assert.equal(calls.length, 4);
  assert.equal(logs.length, 2);
  assert.ok(Math.abs(r.cost - 0.05) < 1e-9);
});

test('after the last retry the error says the connector was not ready', () => {
  const sleeps = [];
  const { ask, calls } = fake(Array.from({ length: 4 }, () => ({ error: NOT_READY })));
  const r = fetchMeetings({ ask, sleep: (ms) => sleeps.push(ms) });
  assert.equal(calls.length, 4, 'first call plus 3 retries');
  assert.equal(sleeps.length, 3);
  assert.equal(r.notReady, true);
  assert.match(r.error, /Wispr connector not ready after 4 tries.*still connecting/);
});

test('another error is not retried', () => {
  const { ask, calls } = fake([{ error: 'bad json from claude' }]);
  const r = fetchMeetings({ ask, sleep: () => assert.fail('must not wait') });
  assert.equal(calls.length, 1);
  assert.match(r.error, /^list failed: bad json/);
});

test('the style rule reaches the meeting writer prompt', () => {
  const { ask, calls } = fake([{ json: [{ id: 'm1', title: 'Sync', start: '2026-03-01T10:00:00Z' }] }, { json: detail }]);
  fetchMeetings({ ask, sleep: () => {}, style: 'STYLE-RULE-MARKER' });
  assert.match(calls[1], /STYLE-RULE-MARKER/);
});

test('status shows a failed import with its time and reason', () => {
  const home = path.join(SCRATCH, 'status-home');
  fs.mkdirSync(path.join(home, 'state'), { recursive: true });
  fs.writeFileSync(path.join(home, 'config.toml'), 'default = "x"\n');
  fs.writeFileSync(path.join(home, 'state', 'sessions.json'), JSON.stringify({ meetings: { failed_at: '2026-03-01T08:00:00.000Z', failed_reason: 'Wispr connector not ready after 4 tries' } }));
  const r = spawnSync(process.execPath, [BIN, 'status'], { encoding: 'utf8', env: { ...process.env, AGENT_WIKI_HOME: home } });
  assert.match(r.stdout, /meetings: last import failed 2026-03-01T08:00:00.000Z: Wispr connector not ready after 4 tries/);
});
