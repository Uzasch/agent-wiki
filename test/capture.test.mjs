import { SCRATCH, mk, write, jsonl } from './setup.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'agent-wiki.mjs');
const HOME_DIR = process.env.AGENT_WIKI_HOME;

// A stand-in for the `claude` program: saves the prompt it gets and answers with a fixed entry.
const stubDir = path.join(SCRATCH, 'stub');
fs.mkdirSync(stubDir, { recursive: true });
fs.writeFileSync(path.join(stubDir, 'claude'), `#!${process.execPath}
const fs = require('node:fs');
const prompt = fs.readFileSync(0, 'utf8');
fs.writeFileSync(process.env.STUB_PROMPT, prompt);
const short = fs.readFileSync(process.env.STUB_SHORT, 'utf8').trim();
const result = ['@@TITLE@@', 'Add the order export', '@@SHORT@@', short, '@@STATUS@@', 'done', '@@PROJECT@@', '', '@@SUMMARY@@',
  'This work lets the shop send each order to the books.', 'The export now runs every night.', '@@DECISIONS@@', '- Run at night — fewer users online',
  '@@HOWTO@@', 'none', '@@NEXT@@', 'none', '@@OUTPUTS@@', '- pr: https://github.com/acme/shop/pull/7 — the change', '@@MEETINGS@@', 'none'].join('\\n');
process.stdout.write(JSON.stringify({ result, total_cost_usd: 0.001 }));
`);
fs.chmodSync(path.join(stubDir, 'claude'), 0o755);

const repo = mk('shop', 'x'); const repoDir = path.dirname(repo);
fs.mkdirSync(path.join(repoDir, '.git'));
fs.writeFileSync(path.join(repoDir, 'GLOSSARY.md'), '# Shop\n\n## Language\n\n**Order**:\nA request from a customer to buy items.\n_Avoid_: purchase, transaction\n\n**Parcel**:\nOne box that leaves the warehouse.\n_Avoid_: package\n');

const vaultDir = path.join(SCRATCH, 'vault');
fs.writeFileSync(path.join(HOME_DIR, 'config.toml'),
  `default = "work"\nmachine = "pc"\n[vaults.work]\npath = "${vaultDir}"\n[folders]\n"${repoDir}" = "work"\n`);

const t = (i) => `2026-03-04T10:00:${String(i).padStart(2, '0')}.000Z`;
const sessionFile = jsonl('claude/proj/11112222-aaaa-bbbb-cccc-ddddeeeeffff.jsonl', [
  { type: 'user', uuid: 'u1', timestamp: t(1), cwd: repoDir, message: { content: 'please add the order export for the books' } },
  { type: 'assistant', uuid: 'a1', timestamp: t(2), message: { model: 'm', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'gh pr create' } }] } },
  { type: 'user', uuid: 'u2', timestamp: t(3), message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'https://github.com/acme/shop/pull/7' }] } },
  { type: 'assistant', uuid: 'a2', timestamp: t(4), message: { model: 'm', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Done. Preview: https://claude.ai/artifact/ExAmPlE12345 and files in /mnt/share/books/export-2026.csv. The order flow is fine.' }] } },
  { type: 'user', uuid: 'u3', timestamp: t(5), message: { content: 'thanks, now check the order totals again' } },
  { type: 'assistant', uuid: 'a3', timestamp: t(6), message: { model: 'm', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Totals match.' }] } },
  { type: 'user', uuid: 'u4', timestamp: t(7), message: { content: 'good, ship it' } },
  { type: 'assistant', uuid: 'a4', timestamp: t(8), message: { model: 'm', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Shipped.' }] } },
]);

function capture(short, extraEnv = {}) {
  fs.writeFileSync(path.join(SCRATCH, 'short.txt'), short);
  const r = spawnSync(process.execPath, [BIN, 'capture', '--tool', 'claude', '--file', sessionFile, '--force'], {
    encoding: 'utf8', env: { PATH: `${stubDir}:/usr/bin:/bin`, HOME: SCRATCH, AGENT_WIKI_HOME: HOME_DIR,
      STUB_PROMPT: path.join(SCRATCH, 'prompt.txt'), STUB_SHORT: path.join(SCRATCH, 'short.txt'), ...extraEnv } });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

test('capture writes a short-named page with merged outputs, and the prompt carries the style and only the matching glossary entries', () => {
  const r = capture('order-export-nightly');
  assert.equal(r.page, 'sessions/2026-03-04-order-export-nightly-11112222.md');
  const page = fs.readFileSync(path.join(vaultDir, r.page), 'utf8');
  // frontmatter outputs list
  assert.match(page, /outputs: \n  - \{"kind":"artifact","url":"https:\/\/claude\.ai\/artifact\/ExAmPlE12345"\}/);
  assert.match(page, /- \{"kind":"pr","url":"https:\/\/github\.com\/acme\/shop\/pull\/7"\}/);
  assert.match(page, /\{"kind":"path","url":"\/mnt\/share\/books\/export-2026\.csv"\}/);
  // body: the model bullet is kept once; the missing ones are added
  const out = page.split('## Outputs')[1].split('\n---')[0];
  assert.equal((out.match(/pull\/7/g) || []).length, 1);
  assert.match(out, /- pr: https:\/\/github\.com\/acme\/shop\/pull\/7 — the change/);
  assert.match(out, /- link: https:\/\/claude\.ai\/artifact\/ExAmPlE12345/);
  assert.match(out, /- path: \/mnt\/share\/books\/export-2026\.csv/);
  // style + glossary
  const prompt = fs.readFileSync(path.join(SCRATCH, 'prompt.txt'), 'utf8');
  assert.match(prompt, /ASD-STE100 Simplified Technical English/);
  assert.match(prompt, /Start the summary with ONE line of context/);
  assert.match(prompt, /^- Order: A request from a customer to buy items\. \| Avoid: purchase, transaction$/m);
  assert.doesNotMatch(prompt, /Parcel/);
  assert.match(prompt, /@@SHORT@@/);
});

test('a recapture of the same session keeps its file, even when the model gives a new short title', () => {
  const r = capture('a-different-name');
  assert.equal(r.page, 'sessions/2026-03-04-order-export-nightly-11112222.md');
  const files = fs.readdirSync(path.join(vaultDir, 'sessions')).filter((f) => f.endsWith('.md'));
  assert.deepEqual(files, ['2026-03-04-order-export-nightly-11112222.md']);
});

test('a vault with drive set never fails the capture when the upload tool is missing', () => {
  const shot = mk('shot', 'x'); const shotFile = path.join(path.dirname(shot), 'page.png'); fs.writeFileSync(shotFile, Buffer.alloc(40 * 1024));
  const withShot = jsonl('claude/proj/33334444-aaaa-bbbb-cccc-ddddeeeeffff.jsonl', [
    { type: 'user', uuid: 'u1', timestamp: t(1), cwd: repoDir, message: { content: 'look at this screenshot please now' } },
    { type: 'assistant', uuid: 'a1', timestamp: t(2), message: { model: 'm', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: shotFile } }] } },
    { type: 'assistant', uuid: 'a2', timestamp: t(3), message: { model: 'm', stop_reason: 'end_turn', content: [{ type: 'text', text: 'It looks fine.' }] } },
    { type: 'user', uuid: 'u2', timestamp: t(4), message: { content: 'ok then check the second one' } },
    { type: 'assistant', uuid: 'a3', timestamp: t(5), message: { model: 'm', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Also fine.' }] } },
    { type: 'user', uuid: 'u3', timestamp: t(6), message: { content: 'good thanks' } },
    { type: 'assistant', uuid: 'a4', timestamp: t(7), message: { model: 'm', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Done.' }] } },
  ]);
  fs.writeFileSync(path.join(HOME_DIR, 'config.toml'),
    `default = "work"\nmachine = "pc"\n[vaults.work]\npath = "${vaultDir}"\ndrive = "SOME-DRIVE-ID"\nauth = "gws"\n[folders]\n"${repoDir}" = "work"\n`);
  fs.writeFileSync(path.join(SCRATCH, 'short.txt'), 'screenshot-check');
  const r = spawnSync(process.execPath, [BIN, 'capture', '--tool', 'claude', '--file', withShot, '--force'], {
    encoding: 'utf8', env: { PATH: `${stubDir}:/nonexistent`, HOME: SCRATCH, AGENT_WIKI_HOME: HOME_DIR, STUB_PROMPT: path.join(SCRATCH, 'prompt.txt'), STUB_SHORT: path.join(SCRATCH, 'short.txt') } });
  assert.equal(r.status, 0, r.stderr);
  const res = JSON.parse(r.stdout);
  assert.equal(res.page, 'sessions/2026-03-04-screenshot-check-33334444.md');
  assert.equal(res.screenshots, 0);
  const page = fs.readFileSync(path.join(vaultDir, res.page), 'utf8');
  assert.doesNotMatch(page, /## Screenshots/);
  assert.match(fs.readFileSync(path.join(HOME_DIR, 'state', 'agent-wiki.log'), 'utf8'), /screenshot upload failed for page\.png/);
});
