import { SCRATCH, mk, write } from './setup.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fetchMeetings, importMeetings, isNotReady } from '../lib/meetings.mjs';
import { initVault } from '../lib/vault.mjs';
import { fakeBin, FAKE_CLAUDE, MCP } from './fakes.mjs';

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
  const env = { ...process.env, AGENT_WIKI_HOME: home, PATH: `${fakeBin({ claude: FAKE_CLAUDE })}:${process.env.PATH}`, FAKE_MCP_LIST: MCP.connector };
  const r = spawnSync(process.execPath, [BIN, 'status'], { encoding: 'utf8', env });
  assert.match(r.stdout, /meetings: last import failed 2026-03-01T08:00:00.000Z: Wispr connector not ready after 4 tries/);
});

test('the tool names of the Wispr server are passed to every model call', () => {
  const seen = [];
  const ask = (prompt, opts) => { seen.push(opts.tools); return seen.length === 1 ? { json: [{ id: 'm1', title: 'Sync', start: '2026-03-01T10:00:00Z' }] } : { json: detail }; };
  fetchMeetings({ ask, sleep: () => {}, tools: ['mcp__wispr__search_meetings', 'mcp__wispr__get_meeting'] });
  assert.equal(seen.length, 2);
  for (const t of seen) assert.deepEqual(t, ['mcp__wispr__search_meetings', 'mcp__wispr__get_meeting']);
});

test('import reports the newest meeting start, and a meeting it could not read as an error', () => {
  const vault = mk('import-vault', 'x').replace(/x$/, '');
  initVault(vault);
  const stubs = [{ id: 'm1', title: 'Sync', start: '2026-03-01T10:00:00Z' }, { id: 'm2', title: 'Later', start: '2026-03-02T10:00:00Z' }, { id: 'm3', title: 'Broken', start: '2026-03-03T10:00:00Z' }];
  const ask = (prompt) => {
    if (/search_meetings/.test(prompt)) return { json: stubs };
    if (prompt.includes('id m3.')) return { error: 'bad json from claude' };
    const id = prompt.includes('id m1.') ? 'm1' : 'm2';
    return { json: { ...detail, id, title: stubs.find((x) => x.id === id).title, start: stubs.find((x) => x.id === id).start } };
  };
  const dry = importMeetings(vault, { dryRun: true, ask, sleep: () => {} });
  assert.equal(dry.newest, '2026-03-02T10:00:00Z');
  assert.equal(dry.errors.length, 1);
  assert.match(dry.errors[0], /^meeting m3: bad json/);
});

test('a meeting call is retried too while the connector is not ready (each call is a new run)', () => {
  const sleeps = [];
  const { ask, calls } = fake([{ json: [{ id: 'm1', title: 'Sync', start: '2026-03-01T10:00:00Z' }] }, { error: NOT_READY }, { json: detail }]);
  const r = fetchMeetings({ ask, sleep: (ms) => sleeps.push(ms), gapMs: 45_000 });
  assert.equal(r.meetings.length, 1);
  assert.deepEqual(r.failed, []);
  assert.deepEqual(sleeps, [45_000]);
  assert.equal(calls.length, 3);
});

test('a meeting that stays not ready after the last try is a failure the caller can see', () => {
  const { ask } = fake([{ json: [{ id: 'm1', title: 'Sync', start: '2026-03-01T10:00:00Z' }] }, ...Array.from({ length: 4 }, () => ({ error: NOT_READY }))]);
  const r = fetchMeetings({ ask, sleep: () => {} });
  assert.equal(r.meetings.length, 0);
  assert.match(r.failed[0], /^meeting m1: .*still connecting/);
});
