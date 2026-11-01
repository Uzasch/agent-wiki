// Projects: hub pages in projects/<slug>.md, assigned automatically (the user never names a project).
// Members = pages in sessions/, meetings/, discussions/, howto/ whose frontmatter `project` is the slug.
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { frontmatter, readFrontmatter } from './vault.mjs';
import { redact } from './redact.mjs';

export const MEMBER_DIRS = ['sessions', 'meetings', 'discussions', 'howto'];
const BATCH = 150;

export const slugify = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
const str = (v) => (typeof v === 'string' ? v.trim() : '');
const oneLine = (s) => String(s || '').replace(/\s+/g, ' ').trim();

// Values of a YAML list key in page text.
export function readList(text, key) {
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return [];
  const lines = m[1].split('\n');
  const i = lines.findIndex((l) => l.startsWith(`${key}:`));
  if (i < 0) return [];
  const out = [];
  for (let j = i + 1; j < lines.length && /^\s+- /.test(lines[j]); j++) {
    const v = lines[j].replace(/^\s+- /, '');
    try { out.push(JSON.parse(v)); } catch { out.push(v); }
  }
  return out;
}

// ---------- list + prompt ----------
export function listProjects(dir) {
  const d = path.join(dir, 'projects');
  if (!fs.existsSync(d)) return [];
  return fs.readdirSync(d).filter((f) => f.endsWith('.md') && f !== 'index.md').sort().map((f) => {
    const file = path.join(d, f);
    const fm = readFrontmatter(file);
    return { slug: f.slice(0, -3), title: str(fm.title) || f.slice(0, -3), description: str(fm.description),
      aliases: readList(fs.readFileSync(file, 'utf8'), 'aliases') };
  });
}

export const projectPromptBlock = (list) => `Existing projects (slug — title — description):
${list.length ? list.map((p) => `${p.slug} — ${p.title} — ${p.description}`).join('\n') : '(none yet)'}`;

export const PROJECT_FIELD_HELP = 'an existing project slug from the list above, or, only if none fits, "new: <Title> — <one line what the project is>". Group by real-world goal or product, not by tool or day; prefer an existing slug';

// Read the model's @@PROJECT@@ answer. Returns { project: slug|'' , newProject? }.
export function parseProjectAnswer(raw, list) {
  const t = oneLine(String(raw || '').split('\n')[0]).replace(/^["'`]|["'`]$/g, '');
  if (!t) return { project: '' };
  const byName = (x) => list.find((p) => p.slug === x.toLowerCase() || slugify(p.title) === slugify(x)
    || p.aliases.some((a) => slugify(a) === slugify(x)));
  const nm = t.match(/^new:\s*(.+)$/i);
  if (nm) {
    const [title, ...rest] = nm[1].split(/\s+[—–-]\s+/);
    const slug = slugify(title);
    if (!slug) return { project: '' };
    const have = byName(title.trim());
    if (have) return { project: have.slug };
    return { project: slug, newProject: { slug, title: title.trim(), description: oneLine(rest.join(' — ')) } };
  }
  const have = byName(t);
  return { project: have ? have.slug : '' };
}

// ---------- pages ----------
const dateOf = (fm, file) => String(fm.start || fm.date || fm.created || fm.updated || path.basename(file).slice(0, 10)).slice(0, 10);

// Edit one frontmatter field, keep every other byte of the file.
export function setFrontmatterField(text, key, value) {
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return text;
  const line = `${key}: ${JSON.stringify(value)}`;
  const lines = m[1].split('\n');
  const i = lines.findIndex((l) => l.startsWith(`${key}:`));
  if (i >= 0) {
    let j = i + 1;
    while (j < lines.length && /^\s+- /.test(lines[j])) j++;
    lines.splice(i, j - i, line);
  } else lines.push(line);
  return `---\n${lines.join('\n')}\n---${text.slice(m[0].length)}`;
}

const writeIfChanged = (file, text) => {
  if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === text) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return true;
};

export function createProjectPage(dir, p) {
  const file = path.join(dir, 'projects', `${p.slug}.md`);
  if (fs.existsSync(file)) return false;
  return writeIfChanged(file, redact(frontmatter({ type: 'Project', title: p.title, description: p.description || '',
    aliases: p.aliases || [], updated: new Date().toISOString().slice(0, 10), tags: ['project'] }) + `\n# ${p.title}\n`));
}

// All member pages: { rel, file, fm, text }.
export function memberPages(dir) {
  const out = [];
  for (const d of MEMBER_DIRS) {
    const p = path.join(dir, d);
    if (!fs.existsSync(p)) continue;
    for (const f of fs.readdirSync(p).filter((x) => x.endsWith('.md')).sort()) {
      const file = path.join(p, f);
      const text = fs.readFileSync(file, 'utf8');
      out.push({ rel: `${d}/${f}`, file, text, fm: readFrontmatter(file) });
    }
  }
  return out;
}

const sectionBullets = (text, heading) => {
  const m = text.match(new RegExp(`\\n## ${heading}\\n([\\s\\S]*?)(?=\\n## |\\n---\\n|$)`));
  return m ? m[1].split('\n').filter((l) => /^\s*[-*] /.test(l)).map((l) => l.replace(/^\s*[-*] /, '').trim()).filter((l) => l && !/^none\.?$/i.test(l)) : [];
};

// Rebuild one hub's body from its members. Keeps hand-written text under "## Notes".
function hubText(dir, proj, members) {
  const file = path.join(dir, 'projects', `${proj.slug}.md`);
  const old = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const notes = (old.match(/\n## Notes\n([\s\S]*)$/) || [])[1]?.replace(/\s+$/, '') || '';
  const rows = members.map((m) => ({ ...m, date: dateOf(m.fm, m.rel), type: m.fm.type || '', title: m.fm.title || m.rel,
    status: String(m.fm.status || '') })).sort((a, b) => b.date.localeCompare(a.date) || a.rel.localeCompare(b.rel));
  const link = (r) => `[${oneLine(r.title)}](../${r.rel})`;
  const timeline = rows.map((r) => `- ${[r.date, r.type.toLowerCase(), link(r), r.status].filter(Boolean).join(' · ')}`);
  const decisions = rows.flatMap((r) => sectionBullets(r.text, 'Decisions').map((b) => `- ${r.date} · ${link(r)} · ${b}`));
  const open = rows.filter((r) => /^(in-progress|open)$/i.test(r.status))
    .flatMap((r) => sectionBullets(r.text, 'Next').map((b) => `- ${link(r)} · ${b}`));
  const updated = rows[0]?.date || String(readFrontmatter(file).updated || '');
  const fm = frontmatter({ type: 'Project', title: proj.title, description: proj.description, aliases: proj.aliases,
    updated: updated || undefined, tags: ['project'] });
  const sec = (h, lines, empty) => `\n## ${h}\n\n${lines.length ? lines.join('\n') : empty}\n`;
  return redact(fm + `\n# ${proj.title}\n${sec('About', [proj.description || '(no description yet)'])}`
    + sec('Timeline', timeline, '(no pages yet)') + sec('Decisions', decisions, '(none yet)') + sec('Open', open, '(nothing open)')
    + (notes ? `\n## Notes\n${notes}\n` : ''));
}

// Rebuild every hub deterministically. Returns the slugs whose page changed.
export function rebuildHubs(dir) {
  const members = memberPages(dir);
  const changed = [];
  for (const proj of listProjects(dir)) {
    const mine = members.filter((m) => m.fm.project === proj.slug);
    if (writeIfChanged(path.join(dir, 'projects', `${proj.slug}.md`), hubText(dir, proj, mine))) changed.push(proj.slug);
  }
  return changed;
}

// ---------- model call ----------
export function askJson(prompt, { model = 'haiku', timeout = 300_000 } = {}) {
  const r = spawnSync('claude', ['-p', '--model', model, '--no-session-persistence', '--tools', '', '--strict-mcp-config',
    '--setting-sources', '', '--disable-slash-commands', '--output-format', 'json'],
  { encoding: 'utf8', env: { ...process.env, AGENT_WIKI_RUNNING: '1' }, input: prompt, timeout, maxBuffer: 64 << 20 });
  if (r.status !== 0) return { error: (r.stderr || r.error?.message || `exit ${r.status}`).slice(0, 500) };
  let d;
  try { d = JSON.parse(r.stdout); } catch { return { error: 'bad json from claude' }; }
  const text = String(d.result || '');
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return { error: `no JSON in reply: ${text.slice(0, 200)}`, cost: d.total_cost_usd };
  try { return { json: JSON.parse(m[0]), cost: d.total_cost_usd }; } catch { return { error: `invalid JSON in reply: ${text.slice(0, 200)}`, cost: d.total_cost_usd }; }
}

// ---------- organize ----------
const sigOf = (m) => crypto.createHash('sha1').update(`${m.fm.title}|${m.fm.description}|${m.fm.status}`).digest('hex').slice(0, 10);

const organizePrompt = (pages, list) => `You organize a personal work wiki into PROJECTS. A project is one real-world goal, product or ongoing topic that several pages (agent sessions, meetings, discussions, how-tos) belong to. Pages about the same goal must share ONE project, even when done with different tools or on different days. Do not make one project per page; do not make catch-all projects like "misc". Prefer existing projects. Create a new project only when no existing one fits.

${projectPromptBlock(list)}

Pages (path | type | date | title | description | current project):
${pages.map((p) => `${p.rel} | ${p.fm.type || ''} | ${dateOf(p.fm, p.rel)} | ${oneLine(p.fm.title)} | ${oneLine(p.fm.description).slice(0, 200)} | ${p.fm.project || '-'}`).join('\n')}

Reply ONLY with strict JSON, no prose:
{"assign": {"<path>": "<project slug>"}, "new": [{"slug": "kebab-case", "title": "...", "description": "one line"}], "merge": [{"from": "<slug>", "to": "<slug>"}]}
- Every listed page needs an entry in assign. Slugs in assign must be an existing slug or one you list in "new".
- "merge" only when two EXISTING projects are clearly the same thing.`;

// Validate the model's reply against what exists. Returns clean { assign, newProjects, merges }.
export function validatePlan(json, pages, list) {
  const newProjects = [];
  for (const n of Array.isArray(json?.new) ? json.new : []) {
    const slug = slugify(n?.slug || n?.title);
    if (slug && str(n?.title) && !list.some((p) => p.slug === slug) && !newProjects.some((p) => p.slug === slug)) {
      newProjects.push({ slug, title: str(n.title), description: oneLine(n.description) });
    }
  }
  const known = new Set([...list.map((p) => p.slug), ...newProjects.map((p) => p.slug)]);
  const merges = [];
  for (const m of Array.isArray(json?.merge) ? json.merge : []) {
    const from = slugify(m?.from); const to = slugify(m?.to);
    if (from !== to && list.some((p) => p.slug === from) && known.has(to) && !merges.some((x) => x.from === from)) merges.push({ from, to });
  }
  const paths = new Set(pages.map((p) => p.rel));
  const assign = {};
  for (const [rel, slug] of Object.entries(json?.assign && typeof json.assign === 'object' ? json.assign : {})) {
    const s = slugify(slug);
    if (paths.has(rel) && known.has(s)) assign[rel] = s;
  }
  return { assign, newProjects, merges };
}

function applyPlan(dir, plan, list) {
  const touched = new Set();
  for (const p of plan.newProjects) createProjectPage(dir, p);
  const setProject = (m, slug) => {
    const next = setFrontmatterField(m.text, 'project', slug);
    if (next === m.text) return;
    fs.writeFileSync(m.file, next); m.text = next; m.fm.project = slug; touched.add(m.rel);
  };
  const all = memberPages(dir);
  // Follow merge chains a→b→c to the final target.
  const target = (s) => { const seen = new Set(); let cur = s; while (plan.merges.find((m) => m.from === cur) && !seen.has(cur)) { seen.add(cur); cur = plan.merges.find((m) => m.from === cur).to; } return cur; };
  for (const mg of plan.merges) {
    const to = target(mg.from);
    if (to === mg.from) continue;
    const fromProj = list.find((p) => p.slug === mg.from);
    const toFile = path.join(dir, 'projects', `${to}.md`);
    if (fs.existsSync(toFile)) {
      let text = fs.readFileSync(toFile, 'utf8');
      const aliases = readList(text, 'aliases');
      for (const a of [mg.from, fromProj?.title, ...(fromProj?.aliases || [])].filter(Boolean)) if (!aliases.includes(a) && a !== to) aliases.push(a);
      const m = text.match(/^---\n([\s\S]*?)\n---/);
      const lines = m[1].split('\n');
      const i = lines.findIndex((l) => l.startsWith('aliases:'));
      let j = i + 1;
      while (i >= 0 && j < lines.length && /^\s+- /.test(lines[j])) j++;
      const block = ['aliases:', ...aliases.map((a) => `  - ${JSON.stringify(a)}`)];
      if (i >= 0) lines.splice(i, j - i, ...block); else lines.push(...block);
      text = `---\n${lines.join('\n')}\n---${text.slice(m[0].length)}`;
      fs.writeFileSync(toFile, text);
    }
    for (const m of all) if (m.fm.project === mg.from) setProject(m, to);
    fs.rmSync(path.join(dir, 'projects', `${mg.from}.md`), { force: true });
  }
  for (const m of all) {
    const want = plan.assign[m.rel];
    if (want) setProject(m, target(want));
  }
  return touched;
}

const stateFile = (stateDir) => path.join(stateDir, 'organize.json');
const loadState = (stateDir) => { try { return JSON.parse(fs.readFileSync(stateFile(stateDir), 'utf8')); } catch { return {}; } };

// Organize one vault. `vaultKey` keys the state. Returns { asked, assigned, new, merged, hubs, cost, error? }.
export function organizeVault(dir, { vaultKey, stateDir, all = false, model = 'haiku', log = () => {} }) {
  const out = { asked: 0, assigned: 0, new: 0, merged: 0, hubs: 0, cost: 0, calls: 0 };
  const st = loadState(stateDir);
  const rec = st[vaultKey]?.pages || {};
  let list = listProjects(dir);
  const slugs = () => new Set(list.map((p) => p.slug));
  const need = memberPages(dir).filter((m) => all || !m.fm.project || !slugs().has(m.fm.project)
    || (rec[m.rel] && rec[m.rel].sig !== sigOf(m)));
  out.asked = need.length;
  const touched = new Set();
  for (let i = 0; i < need.length; i += BATCH) {
    const batch = need.slice(i, i + BATCH);
    const r = askJson(organizePrompt(batch, list), { model });
    out.calls++; out.cost += r.cost || 0;
    if (r.error) { out.error = r.error; log(`organize ${vaultKey}: ${r.error}`); break; }
    const plan = validatePlan(r.json, batch, list);
    const before = new Set(list.map((p) => p.slug));
    for (const t of applyPlan(dir, plan, list)) touched.add(t);
    list = listProjects(dir);
    out.new += list.filter((p) => !before.has(p.slug)).length;
    out.merged += plan.merges.length;
    out.assigned += Object.keys(plan.assign).length;
  }
  out.hubs = rebuildHubs(dir).length;
  // Record what organize saw, so an unchanged page costs nothing next time.
  const pages = {};
  for (const m of memberPages(dir)) pages[m.rel] = { project: m.fm.project || '', sig: sigOf(m) };
  if (!out.error) {
    st[vaultKey] = { at: new Date().toISOString(), pages };
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(stateFile(stateDir), JSON.stringify(st, null, 1));
  }
  out.changed = touched.size + out.hubs;
  return out;
}
