// Fast, model-free search of a vault for the prompt hook: which past pages relate to this prompt?
// Plain keyword scoring (TF-IDF style) over page titles, descriptions, projects and tags.
// Must stay well under 300 ms, so it reads only the head of each page.
import fs from 'node:fs';
import path from 'node:path';

const PAGE_DIRS = ['sessions', 'meetings', 'discussions', 'howto', 'projects'];
const HEAD_BYTES = 4096;
const WEIGHT = { title: 3, project: 2, tags: 1, description: 1.5 };

const STOP = new Set(('the and for are but not you your yours that this these those with from into onto have has had was were been being '
  + 'will would should could can may might must shall about after before again also just only very more most some any all each every '
  + 'other than then there here what when where which who whom why how its our out off over under per via use used using get got '
  + 'make made let lets please want need needs help look check see tell show give take put run does did done doing now still '
  + 'actually really basically probably maybe them one two new old yes okay thanks thank hello they them their his her him she we us me my mine like want wants thing things '
  + 'something anything everything again going gonna wanna able sure right good great').split(/\s+/));

// Words that appear in almost any engineering prompt: they count, but little.
const GENERIC = new Set(('work working add added issue issues user users type types asked ask file files fix fixed update create '
  + 'change test tests code session page build plan data list tool step name time case point set video github channel app '
  + 'agent check read write open close start stop find look try again problem question answer idea way').split(/\s+/));

// Light stemming so "invoices", "invoice", "uploading" and "uploads" meet. Both sides use it, so it only has to be consistent.
export const stem = (w) => {
  if (/^\d+$/.test(w) || w.length < 4) return w;
  let t = w;
  if (/ies$/.test(t) && t.length > 4) t = t.replace(/ies$/, 'y');
  else if (!/(ss|us|is)$/.test(t)) t = t.replace(/s$/, '');
  const ing = t.replace(/(ing|ed)$/, '');
  if (ing !== t && ing.length >= 3) t = ing;
  if (t.length > 3) t = t.replace(/e$/, '');
  return t;
};

export function tokens(text) {
  const out = [];
  for (const w of String(text || '').toLowerCase().replace(/['’]/g, '').split(/[^a-z0-9]+/)) {
    if (!w || STOP.has(w)) continue;
    if (w.length < 3) continue;
    out.push(stem(w));
  }
  return out;
}

// Head of a file → { fm } with the few frontmatter keys search uses.
function headFrontmatter(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(HEAD_BYTES);
    const n = fs.readSync(fd, buf, 0, HEAD_BYTES, 0);
    const text = buf.toString('utf8', 0, n);
    const m = text.match(/^---\n([\s\S]*?)\n---/);
    const fm = {};
    if (!m) return fm;
    const lines = m[1].split('\n');
    for (let i = 0; i < lines.length; i++) {
      const kv = lines[i].match(/^(\w+):\s*(.*)$/);
      if (!kv) continue;
      if (kv[1] === 'tags') {
        const tags = [];
        for (let j = i + 1; j < lines.length && /^\s+- /.test(lines[j]); j++) tags.push(lines[j].replace(/^\s+- /, '').replace(/^"|"$/g, ''));
        fm.tags = tags.join(' ');
        continue;
      }
      let v = kv[2];
      try { v = JSON.parse(v); } catch { /* plain value */ }
      if (typeof v === 'string' || typeof v === 'number') fm[kv[1]] = String(v);
    }
    return fm;
  } catch { return {}; } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ } }
}

// All searchable pages of a vault: [{ rel, title, date, fields: {title, project, tags, description}, sessionId }].
// `cache` (optional) = { path } of a JSON file that remembers parsed pages by size + mtime, so a big vault
// costs one stat per page instead of one read.
export function loadDocs(dir, { cache } = {}) {
  let old = {};
  if (cache) { try { old = JSON.parse(fs.readFileSync(cache.path, 'utf8'))[dir] || {}; } catch { /* no cache yet */ } }
  const fresh = {};
  const docs = [];
  for (const d of PAGE_DIRS) {
    const p = path.join(dir, d);
    let files;
    try { files = fs.readdirSync(p); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.md')) continue;
      const rel = `${d}/${f}`;
      let st;
      try { st = fs.statSync(path.join(p, f)); } catch { continue; }
      const sig = `${st.size}:${Math.round(st.mtimeMs)}`;
      let doc = old[rel]?.sig === sig ? old[rel].doc : null;
      if (!doc) {
        const fm = headFrontmatter(path.join(p, f));
        if (!fm.title) continue;
        doc = { rel, title: fm.title, date: String(fm.start || fm.date || fm.updated || fm.created || f.slice(0, 10)).slice(0, 10),
          sessionId: fm.session_id || '',
          fields: { title: fm.title, project: (fm.project || '').replace(/-/g, ' '), tags: fm.tags || '', description: fm.description || '' } };
      }
      fresh[rel] = { sig, doc };
      docs.push(doc);
    }
  }
  if (cache && JSON.stringify(Object.keys(fresh).sort().map((k) => [k, fresh[k].sig])) !== JSON.stringify(Object.keys(old).sort().map((k) => [k, old[k].sig]))) {
    try {
      let all = {};
      try { all = JSON.parse(fs.readFileSync(cache.path, 'utf8')); } catch { /* new file */ }
      all[dir] = fresh;
      fs.mkdirSync(path.dirname(cache.path), { recursive: true });
      fs.writeFileSync(`${cache.path}.${process.pid}.tmp`, JSON.stringify(all));
      fs.renameSync(`${cache.path}.${process.pid}.tmp`, cache.path);
    } catch { /* a cache that cannot be written is only slower */ }
  }
  // index.md lines for pages outside those folders (e.g. imported history).
  try {
    const known = new Set(docs.map((x) => x.rel));
    for (const m of fs.readFileSync(path.join(dir, 'index.md'), 'utf8').matchAll(/^- \[([^\]]+)\]\(([^)]+\.md)\)(?: — (.*))?$/gm)) {
      if (known.has(m[2]) || PAGE_DIRS.some((x) => m[2].startsWith(`${x}/`))) continue;
      docs.push({ rel: m[2], title: m[1], date: '', sessionId: '', fields: { title: m[1], project: '', tags: '', description: m[3] || '' } });
    }
  } catch { /* no index yet */ }
  return docs;
}

// Rank docs for a prompt. Returns [{ ...doc, score, matched }] best first (unfiltered).
export function rank(docs, prompt) {
  const q = [...new Set(tokens(prompt))];
  if (!q.length || !docs.length) return [];
  const bag = docs.map((d) => {
    const m = new Map();
    for (const [field, text] of Object.entries(d.fields)) for (const t of tokens(text)) m.set(t, Math.max(m.get(t) || 0, WEIGHT[field]));
    return m;
  });
  const df = new Map();
  for (const m of bag) for (const t of m.keys()) df.set(t, (df.get(t) || 0) + 1);
  const N = docs.length;
  // A word on every page says nothing; a word on one page says a lot.
  const idf = (t) => Math.log(N / (df.get(t) || 1)) + 0.1;
  return docs.map((d, i) => {
    let score = 0;
    const matched = [];
    for (const t of q) {
      const w = bag[i].get(t);
      if (!w) continue;
      score += idf(t) * w * (GENERIC.has(t) ? 0.3 : 1);
      matched.push(t);
    }
    return { ...d, score, matched, rare: matched.some((t) => (df.get(t) <= 2 && (t.length >= 5 || /^\d+$/.test(t)))) };
  }).filter((r) => r.matched.length).sort((a, b) => b.score - a.score || (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));   // no localeCompare: it loads ICU (+70 ms)
}

// A good match: two or more prompt words hit the page with real weight, or one rare word (an issue
// number, a product name) hits it. Returns at most `max` pages.
export function search(dir, prompt, { sessionId = '', max = 3, minScore, cache } = {}) {
  const docs = loadDocs(dir, { cache }).filter((d) => !sessionId || d.sessionId !== sessionId);
  // The bar scales with vault size: a vault of 5 pages cannot reach the score a vault of 500 can.
  if (minScore === undefined) minScore = 10 * Math.min(1, Math.log(docs.length + 1) / Math.log(30));
  const hits = rank(docs, prompt);
  const good = hits.filter((h) => (h.matched.length >= 2 && h.score >= minScore) || (h.rare && h.score >= minScore * 0.9));
  if (!good.length) return [];
  const cut = good[0].score * 0.5;
  return good.filter((h) => h.score >= cut).slice(0, max);
}

// The hook's decision: nothing for slash commands and short prompts.
export const worthSearching = (prompt) => {
  const t = String(prompt || '').trim();
  return t.length > 0 && !t.startsWith('/') && t.split(/\s+/).length >= 4;
};

export function contextText(vaultName, dir, hits) {
  const lines = hits.map((h) => `- ${h.title.replace(/\s+/g, ' ').slice(0, 160)} (${h.date || 'undated'}, ${path.join(dir, h.rel)})`);
  return `agent-wiki: related past work in vault "${vaultName}" — open a page if it helps; ignore it if it does not fit:\n${lines.join('\n')}`;
}
