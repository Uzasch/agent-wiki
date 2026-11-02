// `agent-wiki meetings import`, `status` and `install` run as the real command, with fake `claude` and `systemctl`.
import { SCRATCH } from './setup.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { userSlug } from '../lib/wispr.mjs';
import { readList } from '../lib/meetings.mjs';
import { makeRemote, fakeBin, sh, FAKE_CLAUDE, FAKE_SYSTEMCTL, MCP } from './fakes.mjs';

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'agent-wiki.mjs');
const FAKES = fakeBin({ claude: FAKE_CLAUDE, systemctl: FAKE_SYSTEMCTL });
const MEETINGS = JSON.stringify([
  { id: 'm1', title: 'Weekly sync', start: '2026-11-01T10:00:00Z', end: '2026-11-01T10:30:00Z', summary: 'We talked.' },
  { id: 'm2', title: 'Planning', start: '2026-11-01T15:00:00Z', summary: 'We planned.' },
]);

// One machine: its own agent-wiki home, its own clone of the vault, its own log of fake `claude` calls.
let count = 0;
// `user` = the Wispr user as the config says (`wispr_user`); null = not set, so git's email or the OS user name is used.
function machine(name, vaultDir, user = null) {
  const wiki = path.join(SCRATCH, 'machines', `${count++}-${name}`);
  fs.mkdirSync(path.join(wiki, 'wiki'), { recursive: true });
  fs.writeFileSync(path.join(wiki, 'wiki', 'config.toml'), `default = "work"\nmachine = "${name}"\n${user ? `wispr_user = "${user}"\n` : ''}[vaults.work]\npath = "${vaultDir}"\n`);
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

const remoteFile = (bare, rel) => sh('git', ['--git-dir', bare, 'show', `main:${rel}`]);

// Two machines of ONE person (both import as "ann").
function twoMachines() {
  const r = makeRemote();
  const a = machine('machine-a', r.clone('a'), 'ann');
  const b = machine('machine-b', r.clone('b'), 'ann');
  const remoteRun = (user = 'ann') => JSON.parse(remoteFile(r.bare, `.agent-wiki/meetings/${user}.json`));
  return { a, b, remoteRun };
}

// Two people: Ann on two machines, Bob on one. All three share one vault.
function twoPeople() {
  const r = makeRemote();
  const a1 = machine('machine-a1', r.clone('a1'), 'ann');
  const a2 = machine('machine-a2', r.clone('a2'), 'ann');
  const b1 = machine('machine-b1', r.clone('b1'), 'bob');
  const remoteRun = (user) => JSON.parse(remoteFile(r.bare, `.agent-wiki/meetings/${user}.json`));
  const remoteFiles = () => sh('git', ['--git-dir', r.bare, 'ls-tree', '-r', '--name-only', 'main']).split('\n');
  return { a1, a2, b1, remoteRun, remoteFiles, bare: r.bare };
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

test('status says which user this machine imports as, and where the name came from', () => {
  const r = makeRemote();
  const withConfig = machine('cfg', r.clone('c1'), 'ann');
  assert.match(withConfig.run(['status']).out, /^meetings: this machine imports as ann \(from config wispr_user\)$/m);

  const plain = machine('plain', r.clone('c2'));
  const gitFile = path.join(SCRATCH, 'gitconfig-ann');
  fs.writeFileSync(gitFile, '[user]\n\temail = Ann.Lee@example.com\n');
  assert.match(plain.run(['status'], { extra: { GIT_CONFIG_GLOBAL: gitFile } }).out,
    /^meetings: this machine imports as ann-lee-example-com \(from git config --global user\.email\)$/m);

  const osName = userSlug(os.userInfo().username);
  assert.match(plain.run(['status']).out, new RegExp(`^meetings: this machine imports as ${osName} \\(from OS user name\\)$`, 'm'));
});

test('status still shows a failed import with its time and reason', () => {
  const { b } = twoMachines();
  fs.mkdirSync(path.join(b.wiki, 'wiki', 'state'), { recursive: true });
  fs.writeFileSync(path.join(b.wiki, 'wiki', 'state', 'sessions.json'), JSON.stringify({ meetings: { failed_at: '2026-03-01T08:00:00.000Z', failed_reason: 'Wispr connector not ready after 4 tries' } }));
  assert.match(b.run(['status']).out, /meetings: last import failed 2026-03-01T08:00:00.000Z: Wispr connector not ready after 4 tries/);
});

// ---------- one record per person ----------
test('Ann and Bob on separate machines both import the same day; Ann\'s second machine skips; Bob is not blocked', () => {
  const { a1, a2, b1, remoteRun, remoteFiles, bare } = twoPeople();
  const ra = a1.run(['meetings', 'import']);
  assert.equal(ra.status, 0, ra.stderr + ra.out);
  assert.equal(JSON.parse(ra.out).pages.length, 2);

  const rb = b1.run(['meetings', 'import']);
  assert.equal(rb.status, 0, rb.stderr + rb.out);
  const bobRes = JSON.parse(rb.out);   // a JSON result, not "already imported by ..."
  assert.equal(bobRes.pages.length, 2);
  assert.ok(b1.modelCalls().length > 0, 'Bob\'s machine did the work');
  assert.ok(bobRes.pages.every((p) => p.isNew === false && p.joined === 'bob'), 'both meetings already had a page: Bob was added to it');

  const rs = a2.run(['meetings', 'import']);
  assert.equal(rs.status, 0, rs.stderr);
  assert.match(rs.out, /^meetings: already imported by machine-a1 at 20\d\d-.*Z \(use --force to run anyway\)$/);
  assert.equal(a2.modelCalls().length, 0, 'Ann\'s second machine did no work');

  assert.deepEqual(remoteFiles().filter((f) => f.startsWith('.agent-wiki/')), ['.agent-wiki/meetings/ann.json', '.agent-wiki/meetings/bob.json']);
  assert.equal(remoteRun('ann').machine, 'machine-a1');
  assert.equal(remoteRun('bob').machine, 'machine-b1');
  const pages = remoteFiles().filter((f) => /^meetings\/.*\.md$/.test(f));
  assert.equal(pages.length, 2, 'two meetings, two pages: the shared meetings did not get a second page');
  for (const f of pages) assert.deepEqual(readList(remoteFile(bare, f), 'recorded_by'), ['ann', 'bob'], f);
});

test('a second run of Bob\'s other machine is blocked by Bob\'s record, not by Ann\'s', () => {
  const r = makeRemote();
  const a = machine('machine-a', r.clone('a'), 'ann');
  const b1 = machine('machine-b1', r.clone('b1'), 'bob');
  const b2 = machine('machine-b2', r.clone('b2'), 'bob');
  assert.equal(b1.run(['meetings', 'import']).status, 0);
  assert.match(b2.run(['meetings', 'import']).out, /^meetings: already imported by machine-b1 /);
  assert.equal(JSON.parse(a.run(['meetings', 'import']).out).pages.length, 2, 'Ann is not blocked');
});

test('an old vault with one shared record: the first user to run takes it over (same reading point), and the old file is gone', () => {
  const { a1, b1, remoteRun, remoteFiles } = twoPeople();
  const seed = a1.vaultDir;
  fs.mkdirSync(path.join(seed, '.agent-wiki'), { recursive: true });
  fs.writeFileSync(path.join(seed, '.agent-wiki', 'meetings.json'), JSON.stringify({ last_run: '2026-10-01T08:00:00.000Z', machine: 'old-machine', last_meeting_start: '2026-11-01T15:00:00Z' }));
  sh('git', ['-C', seed, 'add', '-A']); sh('git', ['-C', seed, 'commit', '-q', '-m', 'old shared record']); sh('git', ['-C', seed, 'push', '-q']);

  const ra = a1.run(['meetings', 'import']);
  assert.equal(ra.status, 0, ra.stderr + ra.out);
  assert.match(a1.modelCalls().find((c) => /search_meetings/.test(c[1]))[1], /started after 2026-10-31T15:00:00\.000Z/, 'Ann reads from the old record\'s point');
  assert.deepEqual(remoteFiles().filter((f) => f.startsWith('.agent-wiki/')), ['.agent-wiki/meetings/ann.json'], 'the old file is removed');
  assert.equal(remoteRun('ann').machine, 'machine-a1');

  const rb = b1.run(['meetings', 'import']);
  assert.equal(rb.status, 0, rb.stderr + rb.out);
  assert.equal(JSON.parse(rb.out).pages.length, 2, 'Bob has his own record: not blocked');
  assert.equal(remoteRun('bob').machine, 'machine-b1');
});

test('a dry run on an old vault reads the old record and moves nothing', () => {
  const { a1, remoteFiles } = twoPeople();
  fs.mkdirSync(path.join(a1.vaultDir, '.agent-wiki'), { recursive: true });
  fs.writeFileSync(path.join(a1.vaultDir, '.agent-wiki', 'meetings.json'), JSON.stringify({ last_run: '2026-10-01T08:00:00.000Z', machine: 'old-machine', last_meeting_start: '2026-11-01T15:00:00Z' }));
  sh('git', ['-C', a1.vaultDir, 'add', '-A']); sh('git', ['-C', a1.vaultDir, 'commit', '-q', '-m', 'old shared record']); sh('git', ['-C', a1.vaultDir, 'push', '-q']);
  const r = a1.run(['meetings', 'import', '--dry-run']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(a1.modelCalls().find((c) => /search_meetings/.test(c[1]))[1], /started after 2026-10-31T15:00:00\.000Z/);
  assert.ok(remoteFiles().includes('.agent-wiki/meetings.json'));
  assert.ok(fs.existsSync(path.join(a1.vaultDir, '.agent-wiki', 'meetings.json')));
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
