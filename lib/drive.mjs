// Google Drive images for a vault: upload, keep a local copy in _drive/, pull what is missing.
// Vault config: drive = "<shared drive or folder id>", auth = "gws" | "<service-account json path>".
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expand } from './config.mjs';

const FOLDER = 'application/vnd.google-apps.folder';
const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.pdf': 'application/pdf' };
const mimeOf = (f) => MIME[path.extname(f).toLowerCase()] || 'application/octet-stream';
const SHARED = { supportsAllDrives: true };
const esc = (s) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

// ---------- backend 1: gws CLI ----------
function gwsBackend() {
  const run = (args, cwd) => {
    const r = spawnSync('gws', args, { encoding: 'utf8', cwd, maxBuffer: 64 << 20, timeout: 120_000 });
    if (r.error) throw new Error(`gws not runnable: ${r.error.message}`);
    if (r.status !== 0) throw new Error(`gws ${args.slice(0, 3).join(' ')} failed: ${(r.stderr || r.stdout).slice(0, 400)}`);
    const out = r.stdout.trim();
    const start = out.search(/[{[]/);
    return start < 0 ? {} : JSON.parse(out.slice(start));
  };
  return {
    list: (q) => run(['drive', 'files', 'list', '--params', JSON.stringify({
      q, fields: 'files(id,name,mimeType,webViewLink)', corpora: 'allDrives', includeItemsFromAllDrives: true, ...SHARED, pageSize: 100 })]).files || [],
    createFolder: (name, parent) => run(['drive', 'files', 'create', '--params', JSON.stringify({ ...SHARED, fields: 'id,name' }),
      '--json', JSON.stringify({ name, mimeType: FOLDER, parents: [parent] })]),
    upload(file, name, parent) {
      // gws wants the upload path under its cwd, so run from the file's folder.
      return run(['drive', 'files', 'create', '--params', JSON.stringify({ ...SHARED, fields: 'id,name,webViewLink' }),
        '--json', JSON.stringify({ name, parents: [parent] }), '--upload', path.basename(file),
        '--upload-content-type', mimeOf(name)], path.dirname(path.resolve(file)));
    },
    download(id, dest) {
      const dir = path.dirname(path.resolve(dest));
      fs.mkdirSync(dir, { recursive: true });
      run(['drive', 'files', 'get', '--params', JSON.stringify({ fileId: id, alt: 'media', ...SHARED }), '-o', path.basename(dest)], dir);
    },
    remove: (id) => run(['drive', 'files', 'delete', '--params', JSON.stringify({ fileId: id, ...SHARED })]),
  };
}

// ---------- backend 2: service-account JSON (JWT flow, node:crypto + fetch) ----------
const b64u = (b) => Buffer.from(b).toString('base64url');
function saBackend(keyFile) {
  const key = JSON.parse(fs.readFileSync(expand(keyFile), 'utf8'));
  let token = null;
  let expires = 0;
  const bearer = async () => {
    if (token && Date.now() < expires - 60_000) return token;
    const now = Math.floor(Date.now() / 1000);
    const head = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claim = b64u(JSON.stringify({ iss: key.client_email, scope: 'https://www.googleapis.com/auth/drive',
      aud: key.token_uri || 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 }));
    const sig = crypto.sign('RSA-SHA256', Buffer.from(`${head}.${claim}`), key.private_key).toString('base64url');
    const res = await fetch(key.token_uri || 'https://oauth2.googleapis.com/token', { method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${head}.${claim}.${sig}` }) });
    const j = await res.json();
    if (!res.ok) throw new Error(`service-account token failed: ${JSON.stringify(j).slice(0, 300)}`);
    token = j.access_token;
    expires = Date.now() + j.expires_in * 1000;
    return token;
  };
  const call = async (url, init = {}) => {
    const res = await fetch(url, { ...init, headers: { authorization: `Bearer ${await bearer()}`, ...init.headers } });
    if (!res.ok) throw new Error(`Drive ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return res;
  };
  const API = 'https://www.googleapis.com/drive/v3/files';
  return {
    async list(q) {
      const p = new URLSearchParams({ q, fields: 'files(id,name,mimeType,webViewLink)', corpora: 'allDrives',
        includeItemsFromAllDrives: 'true', supportsAllDrives: 'true', pageSize: '100' });
      return (await (await call(`${API}?${p}`)).json()).files || [];
    },
    async createFolder(name, parent) {
      return (await call(`${API}?supportsAllDrives=true&fields=id,name`, { method: 'POST',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, mimeType: FOLDER, parents: [parent] }) })).json();
    },
    async upload(file, name, parent) {
      const boundary = `aw${crypto.randomBytes(8).toString('hex')}`;
      const meta = JSON.stringify({ name, parents: [parent] });
      const body = Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: ${mimeOf(name)}\r\n\r\n`),
        fs.readFileSync(file), Buffer.from(`\r\n--${boundary}--`)]);
      return (await call(`https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id,name,webViewLink`,
        { method: 'POST', headers: { 'content-type': `multipart/related; boundary=${boundary}` }, body })).json();
    },
    async download(id, dest) {
      const res = await call(`${API}/${id}?alt=media&supportsAllDrives=true`);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
    },
    remove: async (id) => { await call(`${API}/${id}?supportsAllDrives=true`, { method: 'DELETE' }); },
  };
}

export function driveFor(vault, vaultName) {
  if (!vault?.drive) throw new Error(`vault "${vaultName}" has no drive set — add drive = "<id>" and auth = "gws" to its config`);
  const auth = vault.auth || 'gws';
  const api = auth === 'gws' ? gwsBackend() : saBackend(auth);
  return { api, root: vault.drive, vaultName };
}

// Folder ids found or made in this process, so several images do not look the same folders up again.
const FOLDERS = new Map();

// Folder path "<vault>/YYYY-MM" → id, creating each level when asked.
export async function folderId({ api, root, vaultName }, month, create) {
  const key = `${root}/${vaultName}/${month}`;
  if (FOLDERS.has(key)) return FOLDERS.get(key);
  let parent = root;
  for (const name of [vaultName, month]) {
    const hit = (await api.list(`name='${esc(name)}' and '${parent}' in parents and mimeType='${FOLDER}' and trashed=false`))[0];
    if (hit) { parent = hit.id; continue; }
    if (!create) return null;
    parent = (await api.createFolder(name, parent)).id;
  }
  FOLDERS.set(key, parent);
  return parent;
}

// Shrink to WebP when a converter exists; otherwise keep the original.
export function toWebp(file, tmpDir) {
  if (path.extname(file).toLowerCase() === '.webp') return file;
  const out = path.join(tmpDir, path.basename(file, path.extname(file)) + '.webp');
  const tries = [['cwebp', ['-quiet', '-q', '82', file, '-o', out]], ['magick', [file, '-quality', '82', out]], ['convert', [file, '-quality', '82', out]]];
  for (const [cmd, args] of tries) {
    const r = spawnSync(cmd, args, { stdio: 'ignore' });
    if (r.status === 0 && fs.existsSync(out)) return out;
  }
  return file;
}

export async function addImage({ vault, vaultName, vaultDir, file, name }) {
  if (!fs.existsSync(file)) throw new Error(`no such file: ${file}`);
  const d = driveFor(vault, vaultName);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-wiki-img-'));
  try {
    const src = toWebp(file, tmp);
    let finalName = name || path.basename(file);
    if (src !== file && path.extname(finalName).toLowerCase() !== '.webp') finalName = finalName.replace(/\.[^.]*$/, '') + '.webp';
    const month = new Date().toISOString().slice(0, 7);
    const folder = await folderId(d, month, true);
    const up = await d.api.upload(src, finalName, folder);
    const local = path.join(vaultDir, '_drive', month, finalName);
    fs.mkdirSync(path.dirname(local), { recursive: true });
    fs.copyFileSync(src, local);
    return { name: finalName, month, local, link: up.webViewLink, id: up.id,
      markdown: `![${finalName}](../_drive/${month}/${finalName})\n[Drive](${up.webViewLink})` };
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

function* mdFiles(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') || e.name === '_drive' || e.name === 'node_modules') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* mdFiles(p);
    else if (e.name.endsWith('.md')) yield p;
  }
}

// Download every `_drive/YYYY-MM/name` image that pages reference but is missing locally.
export async function pullImages({ vault, vaultName, vaultDir }) {
  const want = new Map();
  for (const f of mdFiles(vaultDir)) {
    for (const m of fs.readFileSync(f, 'utf8').matchAll(/_drive\/(\d{4}-\d{2})\/([^)\s"'\]]+)/g)) {
      const name = decodeURIComponent(m[2]);
      if (!fs.existsSync(path.join(vaultDir, '_drive', m[1], name))) want.set(`${m[1]}/${name}`, [m[1], name]);
    }
  }
  const res = { pulled: [], missing: [] };
  if (!want.size) return res;
  const d = driveFor(vault, vaultName);
  const folders = new Map();
  for (const [month, name] of want.values()) {
    if (!folders.has(month)) folders.set(month, await folderId(d, month, false));
    const fid = folders.get(month);
    const hit = fid && (await d.api.list(`name='${esc(name)}' and '${fid}' in parents and trashed=false`))[0];
    if (!hit) { res.missing.push(`${month}/${name}`); continue; }
    await d.api.download(hit.id, path.join(vaultDir, '_drive', month, name));
    res.pulled.push(`${month}/${name}`);
  }
  return res;
}
