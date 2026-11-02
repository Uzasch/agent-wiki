import './setup.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMcpList, pickWispr, toolPrefix, normalizePrefix, wisprTools, wisprLogin } from '../lib/wispr.mjs';
import { MCP } from './fakes.mjs';

const list = (...lines) => ({ stdout: `Checking MCP server health…\n\n${lines.join('\n')}\n${MCP.other}\n` });
const noSleep = () => assert.fail('must not wait');

test('tool prefix follows the server name', () => {
  assert.equal(toolPrefix('claude.ai Wispr Flow'), 'mcp__claude_ai_Wispr_Flow__');
  assert.equal(toolPrefix('wispr'), 'mcp__wispr__');
  assert.equal(toolPrefix('my-wispr.2'), 'mcp__my-wispr_2__');   // "-" and "_" stay, like Claude Code does
  assert.deepEqual(wisprTools('mcp__wispr__'), ['mcp__wispr__search_meetings', 'mcp__wispr__get_meeting']);
  assert.equal(normalizePrefix('wispr'), 'mcp__wispr__');
  assert.equal(normalizePrefix('mcp__wispr__'), 'mcp__wispr__');
  assert.equal(normalizePrefix(''), '');
});

test('parseMcpList reads only the Wispr lines, with or without "(HTTP)" after the URL', () => {
  const s = parseMcpList(list(MCP.connector, MCP.direct).stdout);
  assert.deepEqual(s.map((x) => [x.name, x.connected]), [['claude.ai Wispr Flow', true], ['wispr', true]]);
  const bad = parseMcpList(list(MCP.connectorNeedsAuth, 'wispr: https://api.wisprflow.ai/connect/mcp (HTTP) - ✗ Failed to connect').stdout);
  assert.deepEqual(bad.map((x) => x.connected), [false, false]);
  assert.deepEqual(parseMcpList(MCP.other), []);
});

test('the claude.ai connector alone: login ok, connector tool names', () => {
  const r = wisprLogin({ run: () => list(MCP.connector), sleep: noSleep });
  assert.equal(r.state, 'ok');
  assert.equal(r.name, 'claude.ai Wispr Flow');
  assert.equal(r.prefix, 'mcp__claude_ai_Wispr_Flow__');
});

test('a direct server alone: tool names come from its name', () => {
  const r = wisprLogin({ run: () => list(MCP.direct), sleep: noSleep });
  assert.equal(r.state, 'ok');
  assert.equal(r.prefix, 'mcp__wispr__');
});

test('two Wispr servers, the direct one needs authentication: the connected connector is used', () => {
  const r = wisprLogin({ run: () => list(MCP.directNeedsAuth, MCP.connector), sleep: noSleep });
  assert.equal(r.state, 'ok');
  assert.equal(r.name, 'claude.ai Wispr Flow');
  assert.equal(r.prefix, 'mcp__claude_ai_Wispr_Flow__');
});

test('two Wispr servers, the connector needs authentication: the connected direct server is used', () => {
  const r = wisprLogin({ run: () => list(MCP.connectorNeedsAuth, MCP.direct), sleep: noSleep });
  assert.equal(r.state, 'ok');
  assert.equal(r.prefix, 'mcp__wispr__');
});

test('two connected Wispr servers: the direct one wins, whatever the order', () => {
  assert.equal(pickWispr(parseMcpList(list(MCP.connector, MCP.direct).stdout)).name, 'wispr');
  assert.equal(pickWispr(parseMcpList(list(MCP.direct, MCP.connector).stdout)).name, 'wispr');
});

test('config override wispr_tool_prefix beats the derived prefix', () => {
  assert.equal(wisprLogin({ run: () => list(MCP.connector), prefix: 'mcp__custom__' }).prefix, 'mcp__custom__');
});

test('no Wispr server listed, or every one needs authentication: no login, no waiting', () => {
  for (const out of [list(), list(MCP.connectorNeedsAuth), list(MCP.connectorNeedsAuth, MCP.directNeedsAuth)]) {
    const r = wisprLogin({ run: () => out, sleep: noSleep });
    assert.equal(r.state, 'none');
  }
});

test('claude is not installed: no login (not an error)', () => {
  assert.equal(wisprLogin({ run: () => ({ missing: true }), sleep: noSleep }).state, 'none');
});

test('claude mcp list itself fails or times out: an error', () => {
  const r = wisprLogin({ run: () => ({ error: 'claude mcp list: spawnSync claude ETIMEDOUT' }), sleep: noSleep });
  assert.equal(r.state, 'error');
});

test('a listed server that is still connecting is checked again, then used', () => {
  const answers = [list('claude.ai Wispr Flow: https://api.wisprflow.ai/connect/mcp - ✗ Failed to connect'), list('claude.ai Wispr Flow: https://api.wisprflow.ai/connect/mcp - ✗ Failed to connect'), list(MCP.connector)];
  const sleeps = [];
  const waits = [];
  const r = wisprLogin({ run: () => answers.shift(), sleep: (ms) => sleeps.push(ms), gapMs: 45_000, onWait: (m) => waits.push(m) });
  assert.equal(r.state, 'ok');
  assert.deepEqual(sleeps, [45_000, 45_000]);
  assert.equal(waits.length, 2);
});

test('a server that never connects: no login after the last check', () => {
  let calls = 0;
  const r = wisprLogin({ run: () => { calls++; return list('claude.ai Wispr Flow: https://api.wisprflow.ai/connect/mcp - ✗ Failed to connect'); }, sleep: () => {}, tries: 3 });
  assert.equal(r.state, 'none');
  assert.equal(calls, 4);
  assert.match(r.reason, /Failed to connect/);
});
