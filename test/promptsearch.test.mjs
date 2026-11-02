import { SCRATCH, mk, write } from './setup.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { search, worthSearching, tokens, stem, contextText } from '../lib/promptsearch.mjs';
import { initVault, frontmatter } from '../lib/vault.mjs';

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'agent-wiki.mjs');

function vault(name) {
  const dir = path.join(SCRATCH, name);
  initVault(dir);
  const page = (rel, fm, body = '') => fs.writeFileSync(path.join(dir, rel), `${frontmatter({ type: 'Session', ...fm })}\n${body}`);
  page('sessions/2026-03-01-invoice-export-aaaa1111.md', { title: 'Build the invoice export for the billing team', description: 'Customers get a monthly invoice file. The export uses the billing tables.', project: 'billing-export', start: '2026-03-01T10:00:00Z', session_id: 'aaaa1111-x' });
  page('sessions/2026-03-02-queue-delay-bbbb2222.md', { title: 'Fix the slow render queue', description: 'Jobs wait too long before they start. The worker pool was too small.', project: 'render-queue', start: '2026-03-02T10:00:00Z', session_id: 'bbbb2222-x' });
  page('sessions/2026-03-03-menu-colours-cccc3333.md', { title: 'Change the colours of the menu', description: 'New palette for the side menu.', project: 'website', start: '2026-03-03T10:00:00Z', session_id: 'cccc3333-x' });
  page('discussions/ticket-4821-plan.md', { type: 'Discussion', title: 'Plan for ticket 4821', description: 'How to move the nightly import.', project: 'imports', updated: '2026-03-04' });
  fs.writeFileSync(path.join(dir, 'README.md'), 'x');
  return dir;
}

test('tokens: stopwords and short words go, plurals and endings are folded', () => {
  assert.deepEqual(tokens('Please check the invoices and the exports'), tokens('invoice export'));
  assert.equal(tokens('Please check the invoices and the exports').length, 2);
  assert.equal(stem('uploading'), stem('uploads'));
  assert.equal(stem('created'), stem('creates'));
  assert.equal(stem('queue'), stem('queues'));
  assert.deepEqual(tokens('ticket 4821 is 42'), ['ticket', '4821']);
});

test('worthSearching: nothing for slash commands and prompts under 4 words', () => {
  assert.equal(worthSearching('/set-wiki work'), false);
  assert.equal(worthSearching('fix the bug'), false);
  assert.equal(worthSearching('  '), false);
  assert.equal(worthSearching('please fix the invoice export'), true);
});

test('search finds the related page and ignores unrelated prompts', () => {
  const dir = vault('v-search');
  const hit = search(dir, 'The billing invoice export fails for one customer');
  assert.equal(hit[0].rel, 'sessions/2026-03-01-invoice-export-aaaa1111.md');
  const q = search(dir, 'why is the render queue so slow today');
  assert.equal(q[0].rel, 'sessions/2026-03-02-queue-delay-bbbb2222.md');
  assert.deepEqual(search(dir, 'tell me a joke about penguins in the snow'), []);
  assert.equal(search(dir, 'what did we decide on ticket 4821 again')[0].rel, 'discussions/ticket-4821-plan.md');
  assert.ok(search(dir, 'billing invoice export render queue colours menu everything', { max: 3 }).length <= 3);
});

test('search skips the current session itself', () => {
  const dir = vault('v-self');
  assert.deepEqual(search(dir, 'The billing invoice export fails for one customer', { sessionId: 'aaaa1111-x' }), []);
});

test('the hook prints Claude additionalContext JSON, and nothing when there is no match', () => {
  const dir = vault('v-hook');
  fs.writeFileSync(path.join(process.env.AGENT_WIKI_HOME, 'config.toml'), `default = "w"\n[vaults.w]\npath = "${dir}"\n`);
  const run = (input) => spawnSync(process.execPath, [BIN, 'hook', 'claude-prompt'], { input: JSON.stringify(input), encoding: 'utf8', env: { ...process.env } });
  const t0 = Date.now();
  const ok = run({ prompt: 'The billing invoice export fails for one customer', cwd: '/anywhere', session_id: 'zzz' });
  const ms = Date.now() - t0;
  const out = JSON.parse(ok.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.match(out.hookSpecificOutput.additionalContext, /agent-wiki: related past work/);
  assert.match(out.hookSpecificOutput.additionalContext, /Build the invoice export for the billing team \(2026-03-01, .*invoice-export-aaaa1111\.md\)/);
  assert.ok(ms < 8000, `hook took ${ms} ms (process start included; the box may be busy)`);
  assert.equal(run({ prompt: 'tell me a joke about penguins in the snow', cwd: '/x' }).stdout, '');
  assert.equal(run({ prompt: '/set-wiki work please now', cwd: '/x' }).stdout, '');
  assert.equal(run({ prompt: 'fix it', cwd: '/x' }).stdout, '');
  assert.equal(run({ prompt: 'billing invoice export fails', cwd: '/x', session_id: 'aaaa1111-x' }).stdout, '', 'own session excluded');
  const codex = spawnSync(process.execPath, [BIN, 'hook', 'codex-prompt'], { input: JSON.stringify({ prompt: 'The billing invoice export fails for one customer', cwd: '/x' }), encoding: 'utf8' });
  assert.equal(JSON.parse(codex.stdout).hookSpecificOutput.hookEventName, 'UserPromptSubmit');
});

test('a vault set to off gets no context', () => {
  const dir = vault('v-off');
  fs.writeFileSync(path.join(process.env.AGENT_WIKI_HOME, 'config.toml'), `default = "off"\n[vaults.w]\npath = "${dir}"\n`);
  const r = spawnSync(process.execPath, [BIN, 'hook', 'claude-prompt'], { input: JSON.stringify({ prompt: 'The billing invoice export fails for one customer', cwd: '/x' }), encoding: 'utf8' });
  assert.equal(r.stdout, '');
});

test('the page cache gives the same answer and notices an edited page', () => {
  const dir = vault('v-cache');
  const cache = { path: path.join(SCRATCH, 'cache', 'pages.json') };
  const a = search(dir, 'The billing invoice export fails for one customer', { cache });
  const b = search(dir, 'The billing invoice export fails for one customer', { cache });
  assert.deepEqual(b.map((x) => x.rel), a.map((x) => x.rel));
  assert.ok(fs.existsSync(cache.path));
  fs.writeFileSync(path.join(dir, 'sessions/2026-03-03-menu-colours-cccc3333.md'), `${frontmatter({ type: 'Session', title: 'Penguin migration tracker', description: 'Counts penguins in the snow.', start: '2026-03-03T10:00:00Z' })}\n`);
  assert.equal(search(dir, 'tell me about the penguin migration tracker please', { cache })[0].rel, 'sessions/2026-03-03-menu-colours-cccc3333.md');
});

test('the quick config reader gives the same answers as the full reader, and refuses what it cannot read', async () => {
  const { quickConfig, quickVault, quickVaultPath } = await import('../lib/quickconfig.mjs');
  const { parse } = await import('smol-toml');
  const f = path.join(SCRATCH, 'qc.toml');
  fs.writeFileSync(f, `# comment\ndefault = "work"\nmachine = "pc-1"\nidle_minutes = 50\ninclude_headless = false\n\n[vaults.personal]\nrepo = "me/wiki-personal"\npath = "~/wikis/personal"\n\n[vaults.work]\npath = "/data/wikis/work"   # trailing comment\ndrive = "ABC"\n\n[folders]\n"/data/code/shop" = "work"\n"~/code/mine" = "personal"\n`);
  const q = quickConfig(f);
  const full = parse(fs.readFileSync(f, 'utf8'));
  assert.equal(q.default, full.default);
  assert.deepEqual(JSON.parse(JSON.stringify(q.vaults)), JSON.parse(JSON.stringify(full.vaults)));
  assert.deepEqual(JSON.parse(JSON.stringify(q.folders)), JSON.parse(JSON.stringify(full.folders)));
  assert.equal(quickVault(q, '/data/code/shop/api'), 'work');
  assert.equal(quickVault(q, '/elsewhere'), 'work');
  assert.equal(quickVaultPath(q, 'work'), '/data/wikis/work');
  fs.writeFileSync(f, 'default = "work"\n[vaults.work]\npath = "x"\ntags = ["a", "b"]\n');
  assert.equal(quickConfig(f), null, 'an array is not supported: the caller falls back to the full reader');
});
