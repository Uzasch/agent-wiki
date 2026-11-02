// Deterministic outputs: links, NAS paths and screenshots a session produced.
// No model is involved. The session readers call `harvest` on every piece of raw text (tool inputs,
// tool results, assistant text); `finalizeOutputs` and `pickImages` read the result at capture time.
import fs from 'node:fs';
import path from 'node:path';

export const MAX_OUTPUTS = 40;
export const MAX_IMAGES = 5;
export const IMAGE_MIN = 20 * 1024;
export const IMAGE_MAX = 5 * 1024 * 1024;

// Kinds, in the order they are listed on a page.
const KIND_ORDER = ['artifact', 'sheet', 'doc', 'slides', 'drive', 'pr', 'issue', 'commit', 'link', 'path'];

const URL_RE = /https?:\/\/[^\s<>"'`\\)\]}]+/g;
const NAS_RE = /(?<![\w/.~-])\/mnt\/[^\s<>"'`\\)\]}|;,*?]+/g;
const IMAGE_ABS_RE = /(?<![\w/.~:-])\/[^\s<>"'`\\)\]}|;,*?]+\.(?:png|jpe?g|webp)\b/gi;
const IMAGE_REL_RE = /(?<![\w/.~:-])(?:\.{0,2}\/)?[\w@%+=,.-][\w@%+=,./-]*\.(?:png|jpe?g|webp)\b/gi;

// Tools whose result is a link they just created.
const CREATOR_TOOL = /^(Artifact|mcp__.*(create|upload|publish|share|insert|append|add_|post|send|copy))/i;
const CREATOR_CMD = /\b(gh\s+(pr|issue|release|gist|repo)\s+create|gh\s+release\s+upload|gws\b[^|;&\n]*\b(create|copy|insert|append)\b|git\s+push|npm\s+publish|(vercel|netlify|wrangler|firebase)\b[^|;&\n]*\bdeploy|gcloud\b[^|;&\n]*\bdeploy)\b/;
const SKIP_HOST = /^(localhost|127\.|0\.0\.0\.0|\[::1\]|.*\.local$|example\.(com|org|net)$|.*\.example$)/i;
// Libraries and fonts a page loads: never an output.
const CDN_HOST = /(^|\.)(cdnjs\.cloudflare\.com|jsdelivr\.net|unpkg\.com|tailwindcss\.com|jquery\.com|fonts\.googleapis\.com|fonts\.gstatic\.com|googleapis\.com|gstatic\.com|schema\.org|w3\.org|registry\.npmjs\.org)$/i;
const SECRET_PARAM = /^(token|key|secret|sig|signature|auth|password|access_token|api_?key|x-amz-[\w-]*)$/i;

const trimUrl = (u) => u.replace(/[.,;:!?'"*_]+$/, '').replace(/\\[nrt].*$/, '');

// Canonical form + kind for a URL, or null when it is not an output we keep.
export function classifyUrl(raw, { created = false } = {}) {
  let u;
  try { u = new URL(trimUrl(raw)); } catch { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  const host = u.hostname.toLowerCase();
  const p = u.pathname;
  let m;
  if (host === 'claude.ai' && (m = p.match(/^\/(?:code\/)?artifact\/([\w-]{6,})/))) {
    return { kind: 'artifact', url: `https://claude.ai${p.startsWith('/code/') ? '/code' : ''}/artifact/${m[1]}` };
  }
  if (host === 'docs.google.com' && (m = p.match(/^\/(spreadsheets|document|presentation|forms)\/d\/([\w-]{20,})/))) {
    const kind = m[1] === 'spreadsheets' ? 'sheet' : m[1] === 'presentation' ? 'slides' : 'doc';
    return { kind, url: `https://docs.google.com/${m[1]}/d/${m[2]}` };
  }
  if (host === 'drive.google.com') {
    if ((m = p.match(/^\/(?:file\/d|drive\/folders|drive\/u\/\d+\/folders)\/([\w-]{20,})/))) {
      return { kind: 'drive', url: `https://drive.google.com${p.includes('/folders/') ? '/drive/folders/' : '/file/d/'}${m[1]}` };
    }
    const id = u.searchParams.get('id');
    if (id && /^[\w-]{20,}$/.test(id)) return { kind: 'drive', url: `https://drive.google.com/open?id=${id}` };
    return null;
  }
  if (host === 'github.com') {
    if ((m = p.match(/^\/([\w.-]+\/[\w.-]+)\/(pull|issues)\/(\d+)/))) {
      return { kind: m[2] === 'pull' ? 'pr' : 'issue', url: `https://github.com/${m[1]}/${m[2]}/${m[3]}` };
    }
    if ((m = p.match(/^\/([\w.-]+\/[\w.-]+)\/commit\/([0-9a-f]{7,40})\b/i))) {
      return { kind: 'commit', url: `https://github.com/${m[1]}/commit/${m[2].toLowerCase()}` };
    }
  }
  if (!created || SKIP_HOST.test(host) || CDN_HOST.test(host)) return null;
  for (const k of [...u.searchParams.keys()]) if (SECRET_PARAM.test(k)) u.searchParams.delete(k);
  u.hash = '';
  return { kind: 'link', url: u.toString().replace(/\?$/, '') };
}

export function classifyNasPath(raw) {
  const p = raw.replace(/[.,;:!?]+$/, '');
  const segs = p.split('/').filter(Boolean);
  // A last segment of one character is a path cut at a space: not usable.
  return segs.length >= 3 && segs[0] === 'mnt' && segs.at(-1).length >= 2 ? { kind: 'path', url: p } : null;
}

// Every string inside a value (tool input objects, tool result arrays, ...), flattened.
export function textsOf(v, out = [], depth = 0) {
  if (v == null || depth > 6) return out;
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) for (const x of v) textsOf(x, out, depth + 1);
  else if (typeof v === 'object') for (const x of Object.values(v)) textsOf(x, out, depth + 1);
  return out;
}

export const newHarvest = () => ({ items: new Map(), images: new Map(), tools: new Map() });

// Remember what a tool call was, so its later result can be judged (created a link? took a screenshot?).
export function noteToolCall(h, id, name, input) {
  if (!id) return;
  const cmd = typeof input?.command === 'string' ? input.command : '';
  h.tools.set(id, { name: String(name || ''), creator: CREATOR_TOOL.test(String(name || '')) || CREATOR_CMD.test(cmd) });
}
export const toolCreated = (h, id) => !!h.tools.get(id)?.creator;

const bump = (h, key, rec, ts, weight) => {
  const cur = h.items.get(key);
  if (cur) { cur.score += weight; cur.last = ts || cur.last; return; }
  h.items.set(key, { ...rec, score: weight, first: ts || '', last: ts || '' });
};

// Weight of where a link was seen: the model named it (text) > a tool made it (created) > it only appeared.
const WEIGHT = { text: 3, created: 3, input: 1, result: 1 };

// Scan one piece of raw text. `from` = text | input | result; `created` = the result of a creating tool.
export function harvest(h, text, { ts = '', from = 'result', created = false, cwd = '' } = {}) {
  if (!text || typeof text !== 'string' || text.length < 8) return;
  const w = created ? WEIGHT.created : WEIGHT[from] || 1;
  for (const m of text.matchAll(URL_RE)) {
    const c = classifyUrl(m[0], { created });
    if (c) bump(h, c.url, c, ts, w);
  }
  for (const m of text.matchAll(NAS_RE)) {
    const c = classifyNasPath(m[0]);
    if (c) bump(h, c.url, c, ts, w);
  }
  if (!/\.(?:png|jpe?g|webp)/i.test(text)) return;
  const note = (p) => {
    const abs = path.isAbsolute(p) ? p : cwd ? path.resolve(cwd, p) : '';
    if (!abs || /\/(node_modules|\.git|site-packages|_drive)\//.test(abs) || abs.startsWith('/usr/')) return;
    const cur = h.images.get(abs);
    if (cur) cur.last = ts || cur.last; else h.images.set(abs, { last: ts || '', first: ts || '' });
  };
  for (const m of text.matchAll(IMAGE_ABS_RE)) note(m[0]);
  // Relative paths only count when they sit inside a tool result or input (Playwright style).
  if (from !== 'text') for (const m of text.matchAll(IMAGE_REL_RE)) if (!m[0].startsWith('/') && !/^https?:/.test(m[0])) note(m[0]);
}

// Links and paths, best first, capped. Returns [{ kind, url }] ordered by kind then first seen.
export function finalizeOutputs(h, cap = MAX_OUTPUTS) {
  const rank = (r) => KIND_ORDER.indexOf(r.kind);
  const picked = [...h.items.values()]
    .sort((a, b) => b.score - a.score || rank(a) - rank(b) || a.first.localeCompare(b.first))
    .slice(0, cap);
  return picked.sort((a, b) => rank(a) - rank(b) || a.first.localeCompare(b.first))
    .map(({ kind, url }) => ({ kind, url }));
}

// Add what the model missed: `- link: <url>` lines after the model's own bullets.
export function mergeOutputs(modelText, outputs) {
  const have = (modelText || '').toLowerCase();
  const key = (u) => u.replace(/^https?:\/\//, '').toLowerCase();
  const add = outputs.filter((o) => !have.includes(key(o.url))).map((o) => `- ${o.kind === 'path' ? 'path' : 'link'}: ${o.url}`);
  return [modelText?.trim(), ...add].filter(Boolean).join('\n');
}

// Image files the session wrote or looked at that are still on disk and a sensible size. Newest first.
export function pickImages(h, { max = MAX_IMAGES, min = IMAGE_MIN, maxBytes = IMAGE_MAX } = {}) {
  const out = [];
  for (const [file, rec] of h.images) {
    let st;
    try { st = fs.statSync(file); } catch { continue; }
    if (!st.isFile() || st.size < min || st.size > maxBytes) continue;
    out.push({ file, size: st.size, at: rec.last || new Date(st.mtimeMs).toISOString(), mtime: st.mtimeMs });
  }
  out.sort((a, b) => b.at.localeCompare(a.at) || b.mtime - a.mtime);
  return out.slice(0, max);
}
