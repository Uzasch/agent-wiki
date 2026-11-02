// `agent-wiki meetings import`, `status` and `install` run as the real command, with fake `claude` and `systemctl`.
import { SCRATCH } from './setup.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeRemote, fakeBin, sh, FAKE_CLAUDE, FAKE_SYSTEMCTL, MCP } from './fakes.mjs';

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'agent-wiki.mjs');
const FAKES = fakeBin({ claude: FAKE_CLAUDE, systemctl: FAKE_SYSTEMCTL });
const MEETINGS = JSON.stringify([
  { id: 'm1', title: 'Weekly sync', start: '2026-11-01T10:00:00Z', end: '2026-11-01T10:30:00Z', summary: 'We talked.' },
  { id: 'm2', title: 'Planning', start: '2026-11-01T15:00:00Z', summary: 'We planned.' },
]);

// One machine: its own agent-wiki home, its own clone of the vault, its own log of fake `claude` calls.
let count = 0;
function machine(name, vaultDir) {
  const wiki = path.join(SCRATCH, 'machines', `${count++}-${name}`);
  fs.mkdirSync(path.join(wiki, 'wiki'), { recursive: true });
  fs.writeFileSync(path.join(wiki, 'wiki', 'config.toml'), `default = "work"\nmachine = "${name}"\n[vaults.work]\npath = "${vaultDir}"\n`);
  const claudeLog = path.join(wiki, 'claude.log');
  const run = (args, { mcp = MCP.connector, extra = {}, home: h } = {}) => {
    const r = spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', env: {
      ...process.env, HOME: h || wiki, AGENT_WIKI_HOME: path.join(wiki, 'wiki'), PATH: `${FAKES}:${process.env.PATH}`,
      FAKE_MCP_LIST: mcp, FAKE_MEETINGS: MEETINGS, FAKE_CLAUDE_LOG: claudeLog, FAKE_SYSTEMCTL_LOG: path.join(wiki, 'systemctl.log'), ...extra,
    } });
    return { ...r, out: r.stdout.trim() };
  };
  const modelCalls = () => (fs.existsSync(claudeLog) ? fs.readFileSync(claudeLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((a) => a[0] === '-p') : []);
  return { run, modelCalls, vaultDir, wiki };
}

function twoMachines() {
  const r = makeRemote();
  const a = machine('machine-a', r.clone('a'));
  const b = machine('machine-b', r.clone('b'));
  const remoteRun = () => JSON.parse(sh('git', ['--git-dir', r.bare, 'show', 'main:.agent-wiki/meetings.json']));
  return { a, b, remoteRun };
}

test('A imports and records it; B (also logged in) skips with a reason and makes no model call', () => {
  const { a, b, remoteRun } = twoMachines();
  const ra = a.run(['meetings', 'import']);
  assert.equal(ra.status, 0, ra.stderr + ra.stdout);
  const res = JSON.parse(ra.out);
  assert.equal(res.pages.length, 2);
  assert.ok(fs.existsSync(path.join(a.vaultDir, 'meetings')), 'pages written');
  const rec = remoteRun();
  assert.equal(rec.machine, 'machine-a');
  assert.equal(rec.last_meeting_start, '2026-11-01T15:00:00Z');
  assert.equal(rec.claim_by, undefined);
  assert.ok(a.modelCalls().every((c) => c.includes('mcp__claude_ai_Wispr_Flow__search_meetings') || !/search_meetings|get_meeting/.test(c[1])),
    'the connector tool names are allowed');

  const rb = b.run(['meetings', 'import']);
  assert.equal(rb.status, 0, rb.stderr);
  assert.match(rb.out, /^meetings: already imported by machine-a at 20\d\d-.*Z \(use --force to run anyway\)$/);
  assert.equal(b.modelCalls().length, 0, 'B did not ask the model, so it did no work');
});

test('B with no Wispr login exits 0 with the skip line, and does not claim', () => {
  const { b, remoteRun } = twoMachines();
  for (const mcp of [MCP.other, MCP.connectorNeedsAuth, `${MCP.directNeedsAuth}\n${MCP.connectorNeedsAuth}`]) {
    const r = b.run(['meetings', 'import'], { mcp });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.out, 'meetings: no Wispr login on this machine, skipped');
  }
  assert.equal(b.modelCalls().length, 0);
  assert.throws(() => remoteRun(), 'nothing was claimed or pushed');
});

test('--force imports again; the record then names the forcing machine; the second run reads from the shared point', () => {
  const { a, b, remoteRun } = twoMachines();
  assert.equal(a.run(['meetings', 'import']).status, 0);
  const rb = b.run(['meetings', 'import', '--force']);
  assert.equal(rb.status, 0, rb.stderr + rb.out);
  assert.equal(remoteRun().machine, 'machine-b');
  const listPrompt = b.modelCalls().find((c) => /search_meetings/.test(c[1]))[1];
  assert.match(listPrompt, /started after 2026-10-31T15:00:00\.000Z/, 'since comes from the vault record, not from B\'s own state');
});

test('a direct "wispr" server (the connector needs authentication) gives mcp__wispr__ tool names', () => {
  const { a } = twoMachines();
  const r = a.run(['meetings', 'import'], { mcp: `${MCP.connectorNeedsAuth}\n${MCP.direct}` });
  assert.equal(r.status, 0, r.stderr + r.out);
  const calls = a.modelCalls().filter((c) => /search_meetings|get_meeting/.test(c[1]));
  assert.ok(calls.length >= 2);
  for (const c of calls) {
    const allowed = c.slice(c.indexOf('--allowedTools') + 1);
    assert.ok(allowed.includes('mcp__wispr__search_meetings') && allowed.includes('mcp__wispr__get_meeting'), JSON.stringify(allowed));
    assert.ok(!allowed.some((t) => t.includes('claude_ai')));
  }
});

test('config wispr_tool_prefix overrides the names', () => {
  const { a } = twoMachines();
  const cfgPath = path.join(a.wiki, 'wiki', 'config.toml');
  fs.writeFileSync(cfgPath, `wispr_tool_prefix = "custom_wispr"\n${fs.readFileSync(cfgPath, 'utf8')}`);
  assert.equal(a.run(['meetings', 'import', '--dry-run', '--limit', '1']).status, 0);
  assert.ok(a.modelCalls().some((c) => c.includes('mcp__custom_wispr__search_meetings')));
});

test('a dry run makes no claim and no record, even right after another machine imported', () => {
  const { a, b, remoteRun } = twoMachines();
  assert.equal(a.run(['meetings', 'import']).status, 0);
  const before = JSON.stringify(remoteRun());
  const r = b.run(['meetings', 'import', '--dry-run']);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(JSON.parse(r.out).pages.every((p) => p.dry));
  assert.equal(JSON.stringify(remoteRun()), before);
});

test('a failed import clears the claim and leaves last_run, so the next machine can try', () => {
  const { a, b, remoteRun } = twoMachines();
  const r = a.run(['meetings', 'import'], { extra: { FAKE_MEETINGS: 'not json' } });
  assert.equal(r.status, 1);
  assert.equal(remoteRun().claim_by, undefined);
  assert.equal(remoteRun().last_run, undefined);
  assert.equal(b.run(['meetings', 'import']).status, 0);
  assert.equal(remoteRun().machine, 'machine-b');
});

test('status: last import and machine from the vault, and this machine\'s login', () => {
  const { a, b } = twoMachines();
  assert.equal(a.run(['meetings', 'import']).status, 0);
  sh('git', ['-C', b.vaultDir, 'pull', '-q', '--rebase']);
  const yes = b.run(['status']);
  assert.match(yes.out, /meetings: last import 20\d\d-\S+Z by machine-a \(vault work, read up to meeting at 2026-11-01T15:00:00Z\)/);
  assert.match(yes.out, /meetings: Wispr login on this machine: yes \(claude\.ai Wispr Flow, tools mcp__claude_ai_Wispr_Flow__\*\)/);
  const no = b.run(['status'], { mcp: MCP.other });
  assert.match(no.out, /meetings: Wispr login on this machine: no \(no Wispr Flow server in claude mcp list\)/);
});

test('status still shows a failed import with its time and reason', () => {
  const { b } = twoMachines();
  fs.mkdirSync(path.join(b.wiki, 'wiki', 'state'), { recursive: true });
  fs.writeFileSync(path.join(b.wiki, 'wiki', 'state', 'sessions.json'), JSON.stringify({ meetings: { failed_at: '2026-03-01T08:00:00.000Z', failed_reason: 'Wispr connector not ready after 4 tries' } }));
  assert.match(b.run(['status']).out, /meetings: last import failed 2026-03-01T08:00:00.000Z: Wispr connector not ready after 4 tries/);
});

// ---------- install ----------
const OLD_TIMER = '[Unit]\nDescription=agent-wiki meetings import daily\n\n[Timer]\nOnCalendar=*-*-* 08:00:00\nPersistent=true\n\n[Install]\nWantedBy=timers.target\n';

test('install adds RandomizedDelaySec=30min to a fresh meetings timer', () => {
  const m = machine('fresh', path.join(SCRATCH, 'unused'));
  const home = path.join(SCRATCH, 'install-fresh-home');
  fs.mkdirSync(home, { recursive: true });
  const r = m.run(['install'], { home });
  assert.equal(r.status, 0, r.stderr + r.out);
  const timer = fs.readFileSync(path.join(home, '.config/systemd/user/agent-wiki-meetings.timer'), 'utf8');
  assert.match(timer, /^OnCalendar=\*-\*-\* 08:00:00$/m);
  assert.match(timer, /^RandomizedDelaySec=30min$/m);
  assert.match(timer, /^Persistent=true$/m);
  assert.match(fs.readFileSync(path.join(m.wiki, 'systemctl.log'), 'utf8'), /--user enable --now agent-wiki-meetings\.timer/);
});

test('install rewrites an older meetings timer that has no delay (and reloads systemd); a second run changes nothing', () => {
  const m = machine('older', path.join(SCRATCH, 'unused'));
  const home = path.join(SCRATCH, 'install-old-home');
  const unit = path.join(home, '.config/systemd/user');
  fs.mkdirSync(unit, { recursive: true });
  fs.writeFileSync(path.join(unit, 'agent-wiki-meetings.timer'), OLD_TIMER);
  fs.writeFileSync(path.join(unit, 'agent-wiki-meetings.service'), '[Service]\nExecStart=/old/path\n');
  fs.writeFileSync(path.join(unit, 'agent-wiki-sweep.timer'), 'keep\n');

  const dry = m.run(['install', '--dry-run'], { home });
  assert.match(dry.out, /update systemd user timer agent-wiki-meetings \(add RandomizedDelaySec=30min\)/);
  assert.equal(fs.readFileSync(path.join(unit, 'agent-wiki-meetings.timer'), 'utf8'), OLD_TIMER, 'a dry run writes nothing');

  const r = m.run(['install'], { home });
  assert.equal(r.status, 0, r.stderr + r.out);
  const timer = fs.readFileSync(path.join(unit, 'agent-wiki-meetings.timer'), 'utf8');
  assert.match(timer, /^RandomizedDelaySec=30min$/m);
  assert.match(timer, /^OnCalendar=\*-\*-\* 08:00:00$/m);
  assert.equal(fs.readFileSync(path.join(unit, 'agent-wiki-sweep.timer'), 'utf8'), 'keep\n', 'other timers are left alone');
  assert.match(fs.readFileSync(path.join(unit, 'agent-wiki-meetings.service'), 'utf8'), /\/old\/path/, 'the service file is left alone');
  const sc = fs.readFileSync(path.join(m.wiki, 'systemctl.log'), 'utf8');
  assert.match(sc, /--user daemon-reload/);
  assert.match(sc, /--user restart agent-wiki-meetings\.timer/);

  const again = m.run(['install'], { home });
  assert.doesNotMatch(again.out, /agent-wiki-meetings/);
  assert.equal(fs.readFileSync(path.join(unit, 'agent-wiki-meetings.timer'), 'utf8'), timer);
});
