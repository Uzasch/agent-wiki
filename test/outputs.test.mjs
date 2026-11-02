import { SCRATCH, jsonl, write, mk } from './setup.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { readClaude } from '../lib/sessions.mjs';
import { classifyUrl, classifyNasPath, finalizeOutputs, pickImages, mergeOutputs, newHarvest, harvest } from '../lib/outputs.mjs';

const SHEET = '1aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789abcd';
const PNG = (n) => Buffer.alloc(n, 1);

test('classifyUrl keeps artifacts, Google files, GitHub PR/issue/commit and drops the rest', () => {
  assert.deepEqual(classifyUrl('https://claude.ai/artifact/AbCd12345678?x=1'), { kind: 'artifact', url: 'https://claude.ai/artifact/AbCd12345678' });
  assert.equal(classifyUrl('https://claude.ai/code/artifact/0f8e2c1a-1111-4222-8333-444455556666').kind, 'artifact');
  assert.equal(classifyUrl('https://claude.ai/artifact/{id}'), null);   // a placeholder in tool docs
  assert.deepEqual(classifyUrl(`https://docs.google.com/spreadsheets/d/${SHEET}/edit?gid=0#gid=0`), { kind: 'sheet', url: `https://docs.google.com/spreadsheets/d/${SHEET}` });
  assert.equal(classifyUrl(`https://docs.google.com/document/d/${SHEET}/edit`).kind, 'doc');
  assert.equal(classifyUrl(`https://docs.google.com/presentation/d/${SHEET}/edit`).kind, 'slides');
  assert.equal(classifyUrl(`https://drive.google.com/drive/folders/${SHEET}?usp=sharing`).kind, 'drive');
  assert.equal(classifyUrl('https://docs.google.com/spreadsheets/d/short/edit'), null);
  assert.deepEqual(classifyUrl('https://github.com/acme/tool/pull/12/files#diff'), { kind: 'pr', url: 'https://github.com/acme/tool/pull/12' });
  assert.equal(classifyUrl('https://github.com/acme/tool/issues/7#issuecomment-1').kind, 'issue');
  assert.equal(classifyUrl('https://github.com/acme/tool/commit/ABCDEF1234567').url, 'https://github.com/acme/tool/commit/abcdef1234567');
  assert.equal(classifyUrl('https://github.com/acme/tool'), null);
});

test('generic links count only when a tool created them, and never CDNs, localhost or secrets', () => {
  assert.equal(classifyUrl('https://app.example-site.dev/page'), null);
  assert.equal(classifyUrl('https://app.example-site.dev/page', { created: true }).kind, 'link');
  assert.equal(classifyUrl('https://cdnjs.cloudflare.com/ajax/libs/x.js', { created: true }), null);
  assert.equal(classifyUrl('http://localhost:3000/x', { created: true }), null);
  assert.equal(classifyUrl('https://files.example-site.dev/a?token=abc123&id=5', { created: true }).url, 'https://files.example-site.dev/a?id=5');
});

test('classifyNasPath needs a real path under /mnt', () => {
  assert.equal(classifyNasPath('/mnt/share/team/clip.mp4.').url, '/mnt/share/team/clip.mp4');
  assert.equal(classifyNasPath('/mnt/share'), null);
  assert.equal(classifyNasPath('/mnt/share/team/I'), null);   // cut at a space
});

test('reading a Claude session finds links in tool inputs, tool results and assistant text', () => {
  const png = mk('shots', 'ok.png'); fs.writeFileSync(png, PNG(30 * 1024));
  const tiny = mk('shots', 'tiny.png'); fs.writeFileSync(tiny, PNG(500));
  const huge = mk('shots', 'huge.png'); fs.writeFileSync(huge, PNG(6 * 1024 * 1024));
  const rel = mk('proj', '.pw', 'page.png'); fs.writeFileSync(rel, PNG(25 * 1024));
  const t = (i) => `2026-01-01T00:00:${String(i).padStart(2, '0')}.000Z`;
  const file = jsonl('claude/s1.jsonl', [
    { type: 'user', uuid: 'u1', timestamp: t(1), cwd: `${SCRATCH}/proj`, message: { content: 'build the thing please now' } },
    { type: 'assistant', uuid: 'a1', timestamp: t(2), message: { model: 'm', stop_reason: 'tool_use', content: [
      { type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'gh pr create --title x' } },
      { type: 'tool_use', id: 'tu2', name: 'Read', input: { file_path: png } },
      { type: 'tool_use', id: 'tu3', name: 'Read', input: { file_path: tiny } },
      { type: 'tool_use', id: 'tu4', name: 'Read', input: { file_path: huge } },
      { type: 'tool_use', id: 'tu5', name: 'Bash', input: { command: 'ls /mnt/share/team/out/final.mp4' } },
    ] } },
    { type: 'user', uuid: 'u2', timestamp: t(3), message: { content: [
      { type: 'tool_result', tool_use_id: 'tu1', content: 'https://github.com/acme/tool/pull/42\nhttps://deploy.example-site.dev/build/9' },
      { type: 'tool_result', tool_use_id: 'tu5', content: [{ type: 'text', text: 'ok https://claude.ai/artifact/ZzYyXx998877 here' }] },
      { type: 'tool_result', tool_use_id: 'tu2', content: '- [Screenshot](.pw/page.png)' },
    ] } },
    { type: 'assistant', uuid: 'a2', timestamp: t(4), message: { model: 'm', stop_reason: 'end_turn', content: [
      { type: 'text', text: `Done. Sheet: https://docs.google.com/spreadsheets/d/${SHEET}/edit and https://example.org/not-created` },
    ] } },
  ]);
  const s = readClaude(file);
  const out = finalizeOutputs(s.harvest);
  const urls = out.map((o) => o.url);
  assert.ok(urls.includes('https://github.com/acme/tool/pull/42'));
  assert.ok(urls.includes('https://claude.ai/artifact/ZzYyXx998877'));
  assert.ok(urls.includes(`https://docs.google.com/spreadsheets/d/${SHEET}`));
  assert.ok(urls.includes('https://deploy.example-site.dev/build/9'), 'a link printed by a creating command');
  assert.ok(urls.includes('/mnt/share/team/out/final.mp4'));
  assert.ok(!urls.some((u) => u.includes('example.org')), 'a link only mentioned in text is not created');
  assert.equal(new Set(urls).size, urls.length, 'deduped');
  const imgs = pickImages(s.harvest).map((i) => i.file);
  assert.ok(imgs.includes(png), 'absolute path in a tool input');
  assert.ok(imgs.includes(rel), 'relative path in a tool result, resolved from the session folder');
  assert.ok(!imgs.includes(tiny) && !imgs.includes(huge), 'size window 20 KB - 5 MB');
});

test('outputs are capped at 40 and images at 5, newest first', () => {
  const h = newHarvest();
  for (let i = 0; i < 60; i++) harvest(h, `see https://github.com/acme/tool/issues/${i + 1}`, { ts: `2026-01-01T00:00:${String(i % 60).padStart(2, '0')}Z`, from: 'text' });
  assert.equal(finalizeOutputs(h).length, 40);
  const dir = mk('imgs', 'x');
  fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
  const h2 = newHarvest();
  for (let i = 0; i < 8; i++) {
    const f = `${dir}/p${i}.png`; fs.writeFileSync(f, PNG(30 * 1024));
    harvest(h2, `wrote ${f}`, { ts: `2026-01-01T00:00:0${i}Z`, from: 'input' });
  }
  const got = pickImages(h2);
  assert.equal(got.length, 5);
  assert.ok(got[0].file.endsWith('p7.png') && got[4].file.endsWith('p3.png'));
});

test('mergeOutputs keeps the model bullets and adds only what is missing', () => {
  const model = '- pr: https://github.com/acme/tool/pull/42 — the change\n- file: notes.md';
  const merged = mergeOutputs(model, [
    { kind: 'pr', url: 'https://github.com/acme/tool/pull/42' },
    { kind: 'artifact', url: 'https://claude.ai/artifact/ZzYyXx998877' },
    { kind: 'path', url: '/mnt/share/team/out/final.mp4' },
  ]);
  assert.equal(merged, `${model}\n- link: https://claude.ai/artifact/ZzYyXx998877\n- path: /mnt/share/team/out/final.mp4`);
  assert.equal(mergeOutputs('', [{ kind: 'pr', url: 'https://github.com/acme/tool/pull/1' }]), '- link: https://github.com/acme/tool/pull/1');
});
