import { SCRATCH, mk } from './setup.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildScreenshots, existingBlocks } from '../lib/screenshots.mjs';

const session = { id: 'abcdef12-0000', events: [{ ts: '2026-03-04T10:00:00Z' }] };
const imgs = (n) => Array.from({ length: n }, (_, i) => { const f = mk('shots-t', `shot${i}.png`); fs.writeFileSync(f, Buffer.alloc(30 * 1024)); return { file: f }; });
const fakeUpload = (log) => async ({ file, name }) => { log.push(name); return { name: name.replace(/\.png$/, '.webp'), month: '2026-03', link: `https://drive.example.org/${name}` }; };

test('no drive on the vault: nothing happens, silently', async () => {
  const log = [];
  assert.equal(await buildScreenshots({ images: imgs(2), vault: { path: 'x' }, vaultName: 'v', vaultDir: '/v', session, upload: fakeUpload(log) }), '');
  assert.deepEqual(log, []);
});

test('each image is uploaded under a unique name and embedded with its Drive link', async () => {
  const log = [];
  const md = await buildScreenshots({ images: imgs(2), vault: { drive: 'D' }, vaultName: 'v', vaultDir: '/v', session, upload: fakeUpload(log) });
  assert.deepEqual(log, ['2026-03-04-abcdef12-shot0.png', '2026-03-04-abcdef12-shot1.png']);
  assert.match(md, /^!\[shot0\.png\]\(\.\.\/_drive\/2026-03\/2026-03-04-abcdef12-shot0\.webp\)\n\[Drive\]\(https:\/\/drive\.example\.org\/2026-03-04-abcdef12-shot0\.png\)\n\n!\[shot1\.png\]/);
});

test('an upload error is logged and skipped; the other images still land', async () => {
  const logs = [];
  let n = 0;
  const upload = async ({ name }) => { if (n++ === 0) throw new Error('quota exceeded'); return { name, month: '2026-03', link: 'https://drive.example.org/ok' }; };
  const md = await buildScreenshots({ images: imgs(2), vault: { drive: 'D' }, vaultName: 'v', vaultDir: '/v', session, upload, log: (m) => logs.push(m) });
  assert.equal((md.match(/!\[/g) || []).length, 1);
  assert.match(logs[0], /shot0\.png.*quota exceeded/);
});

test('a recapture reuses what the page already shows and uploads only new images', async () => {
  const log = [];
  const first = await buildScreenshots({ images: imgs(1), vault: { drive: 'D' }, vaultName: 'v', vaultDir: '/v', session, upload: fakeUpload(log) });
  const page = `# T\n\n## Screenshots\n\n${first}\n\n---\nfooter`;
  assert.equal(existingBlocks(page).size, 1);
  const second = await buildScreenshots({ images: imgs(2), vault: { drive: 'D' }, vaultName: 'v', vaultDir: '/v', session, existing: page, upload: fakeUpload(log) });
  assert.deepEqual(log, ['2026-03-04-abcdef12-shot0.png', '2026-03-04-abcdef12-shot1.png'], 'shot0 was not uploaded twice');
  assert.equal((second.match(/!\[/g) || []).length, 2);
});
