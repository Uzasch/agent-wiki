import { SCRATCH, mk, write } from './setup.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { shortFromTitle, cleanShort, sessionFileName } from '../lib/names.mjs';
import { parse } from '../lib/summarise.mjs';
import { writeSessionPage, findSessionPage, initVault, frontmatter } from '../lib/vault.mjs';
import { planRenames, applyRenames } from '../lib/migrate.mjs';
import { brokenLinks } from '../lib/links.mjs';

test('shortFromTitle drops filler and lead verbs, keeps at most 5 words and 40 characters', () => {
  assert.equal(shortFromTitle('Design and build of the invoice export for the billing team'), 'invoice-export-billing-team');
  assert.equal(shortFromTitle('Merge #12 and #15, then run the live steps'), '12-15');
  assert.equal(shortFromTitle('Fix the slow render queue (issue #9) — and more'), 'slow-render-queue');
  const long = shortFromTitle('Compile channel status and approval readiness summaries for the team and draft emails');
  assert.ok(long.split('-').length >= 3 && long.split('-').length <= 5 && long.length <= 40, long);
  assert.ok(shortFromTitle('Extraordinarily-long-words-everywhere each-one-is-huge-and-never-ends-here').length <= 40);
  assert.equal(shortFromTitle('   '), 'session');
});

test('cleanShort accepts a good model slug and repairs a bad one', () => {
  assert.equal(cleanShort('fix-render-queue-delay', 'x'), 'fix-render-queue-delay');
  assert.equal(cleanShort('  "Fix Render Queue"\n', 'x'), 'fix-render-queue');
  assert.equal(cleanShort('', 'Update the invoice export'), 'invoice-export');
  assert.equal(cleanShort('a b c d e f g h i j k', 'Update the invoice export'), 'invoice-export');
});

test('the summary parser reads @@SHORT@@', () => {
  const p = parse('@@TITLE@@\nA title\n@@SHORT@@\nfix-queue-delay\n@@STATUS@@\ndone\n@@PROJECT@@\n\n@@SUMMARY@@\nline');
  assert.equal(p.short, 'fix-queue-delay');
  assert.equal(parse('@@TITLE@@\nA title\n@@STATUS@@\ndone\n@@SUMMARY@@\nx').short, undefined);
});

const session = (id) => ({ tool: 'claude', id, cwd: '/x', model: 'm', events: [{ id: 'e1', ts: '2026-03-04T10:00:00.000Z', role: 'user', text: 'hi' }, { id: 'e2', ts: '2026-03-04T11:00:00.000Z', role: 'assistant', text: 'ok' }] });

test('a session page is named date-short-id8, and a recapture keeps the same file', () => {
  const dir = mk('v1', 'x'); fs.rmSync(path.dirname(dir), { recursive: true, force: true }); initVault(path.dirname(dir));
  const v = path.dirname(dir);
  const s = session('abcdef12-3456-7890-abcd-ef1234567890');
  const a = writeSessionPage(v, s, { title: 'First title here', short: 'first-title', status: 'done', summary: 'x' }, { machine: 'm1', vaultName: 'v' });
  assert.equal(a, 'sessions/2026-03-04-first-title-abcdef12.md');
  const b = writeSessionPage(v, s, { title: 'A completely different title', short: 'other-name', status: 'done', summary: 'y' }, { machine: 'm1', vaultName: 'v' });
  assert.equal(b, a, 'same session, same path');
  assert.equal(fs.readdirSync(path.join(v, 'sessions')).filter((f) => f.endsWith('.md')).length, 1);
  assert.equal(findSessionPage(v, s), a);
  assert.equal(findSessionPage(v, session('99999999-0000')), null);
  // An old-style name is also found, and kept.
  fs.writeFileSync(path.join(v, 'sessions', '2026-02-01-claude-77777777.md'), frontmatter({ type: 'Session', title: 'old', session_id: '77777777-aaaa' }));
  const c = writeSessionPage(v, session('77777777-aaaa'), { title: 'Old again', short: 'new-short', status: 'done', summary: 'z' }, { machine: 'm1', vaultName: 'v' });
  assert.equal(c, 'sessions/2026-02-01-claude-77777777.md');
});

test('migrate-names renames old pages and rewrites every link form, with no broken link left', () => {
  const v = mk('v2', 'x'); const vault = path.dirname(v);
  fs.rmSync(vault, { recursive: true, force: true }); initVault(vault);
  const old = '2026-02-01-claude-aaaa1111.md';
  const old2 = '2026-02-02-codex-bbbb2222.md';
  fs.writeFileSync(path.join(vault, 'sessions', old), frontmatter({ type: 'Session', title: 'Build the invoice export for billing', session_id: 'aaaa1111-z' }) + '\n# T\n');
  fs.writeFileSync(path.join(vault, 'sessions', old2), frontmatter({ type: 'Session', title: 'Research queue tools', session_id: 'bbbb2222-z' }) + `\n# T\n\nSee [other](${old}).\n`);
  fs.mkdirSync(path.join(vault, 'log', 'pc'), { recursive: true });
  fs.writeFileSync(path.join(vault, 'log', 'pc', '2026-02.md'), `- x [T](../../sessions/${old}) · done\n- y [U](../../sessions/${old2})\n`);
  fs.writeFileSync(path.join(vault, 'meetings', '2026-02-03-sync.md'), `${frontmatter({ type: 'Meeting', title: 'Sync', sessions: [`sessions/${old}`] })}\n- [T](../sessions/${old}) — sure\n`);
  fs.writeFileSync(path.join(vault, 'projects', 'p.md'), `${frontmatter({ type: 'Project', title: 'P' })}\n- [T](../sessions/${old})\n`);
  fs.writeFileSync(path.join(vault, 'index.md'), `- [T](sessions/${old})\n- [U](sessions/${old2})\n`);
  assert.equal(brokenLinks(vault).length, 0);
  const plan = planRenames(vault);
  assert.deepEqual(plan.map((p) => p.to), ['2026-02-01-invoice-export-billing-aaaa1111.md', '2026-02-02-queue-tools-bbbb2222.md']);
  const r = applyRenames(vault, plan);
  assert.equal(r.renamed, 2);
  assert.deepEqual(brokenLinks(vault), []);
  assert.ok(fs.readFileSync(path.join(vault, 'meetings', '2026-02-03-sync.md'), 'utf8').includes('"sessions/2026-02-01-invoice-export-billing-aaaa1111.md"'));
  assert.ok(fs.readFileSync(path.join(vault, 'sessions', '2026-02-02-queue-tools-bbbb2222.md'), 'utf8').includes('(2026-02-01-invoice-export-billing-aaaa1111.md)'));
  assert.deepEqual(planRenames(vault), [], 'a second run has nothing to do');
});

test('brokenLinks reports a missing target', () => {
  const v = mk('v3', 'x'); const vault = path.dirname(v);
  fs.rmSync(vault, { recursive: true, force: true }); initVault(vault);
  fs.writeFileSync(path.join(vault, 'sessions', 'a.md'), 'see [gone](b.md) and [web](https://example.org/x.md)\n');
  assert.deepEqual(brokenLinks(vault), [{ file: 'sessions/a.md', link: 'b.md' }]);
});
