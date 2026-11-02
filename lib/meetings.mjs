// Wispr Flow meetings → vault pages, linked both ways with session pages.
// Wispr is a claude.ai connector, so a headless `claude -p` with only the Wispr tools fetches the data.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { frontmatter, readFrontmatter } from './vault.mjs';
import { redact } from './redact.mjs';
import { listProjects, projectPromptBlock, parseProjectAnswer, createProjectPage, PROJECT_FIELD_HELP } from './projects.mjs';
import { wisprTools } from './wispr.mjs';

const ENV = { ...process.env, AGENT_WIKI_RUNNING: '1' };
const WISPR_TOOLS = wisprTools();   // the claude.ai connector's names; the caller passes `tools` when the server has another name
const DAY = 86400_000;

// A connector that is still starting says so in its reply; that is worth a wait, not a failure.
export const NOT_READY = /still connecting|not (yet )?connected|isn'?t available|is not available|unavailable|not ready|connecting/i;
export const isNotReady = (text) => NOT_READY.test(String(text || ''));
export const READY_TRIES = 3;   // retries after the first call
export const READY_GAP_MS = 45_000;
const syncSleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'meeting';
const utc = (t) => { const ms = Date.parse(t); return Number.isNaN(ms) ? null : new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z'); };

// One headless model call. Returns { json, cost } or { error }. Never throws.
export function askModel(prompt, { model = 'haiku', tools = [], timeout = 300_000 } = {}) {
  const args = ['-p', prompt, '--no-session-persistence', '--model', model, '--output-format', 'json', '--tools', ''];
  if (tools.length) args.push('--allowedTools', ...tools);
  const r = spawnSync('claude', args, { encoding: 'utf8', env: ENV, input: '', timeout, maxBuffer: 64 << 20 });
  if (r.status !== 0) return { error: (r.stderr || r.error?.message || `exit ${r.status}`).slice(0, 500) };
  let d;
  try { d = JSON.parse(r.stdout); } catch { return { error: 'bad json from claude' }; }
  const text = String(d.result || '');
  const m = text.match(/[[{][\s\S]*[\]}]/);
  if (!m) return { error: `no JSON in reply: ${text.slice(0, 200)}`, cost: d.total_cost_usd };
  try { return { json: JSON.parse(m[0]), cost: d.total_cost_usd }; } catch { return { error: `invalid JSON in reply: ${text.slice(0, 200)}`, cost: d.total_cost_usd }; }
}

const str = (v) => (typeof v === 'string' ? v.trim() : '');
const strList = (v) => (Array.isArray(v) ? v.map((x) => str(typeof x === 'object' && x ? x.name || x.email : x)).filter(Boolean) : []);

// Validate one meeting object from the model. Returns the clean meeting or null.
export function validateMeeting(m) {
  if (!m || typeof m !== 'object' || !str(m.id)) return null;
  const start = utc(m.start);
  if (!start) return null;
  return {
    id: str(m.id),
    title: str(m.title) || 'Untitled meeting',
    start,
    end: utc(m.end),
    attendees: strList(m.attendees),
    summary: str(m.summary),
    decisions: strList(m.decisions),
    actions: (Array.isArray(m.action_items) ? m.action_items : []).map((a) => (typeof a === 'string'
      ? { text: a.trim(), owner: '' } : { text: str(a?.text), owner: str(a?.owner) })).filter((a) => a.text),
    link: str(m.share_link),
    projectAnswer: str(m.project),
  };
}

const LANG = 'Notes may mix Hindi and English: write everything in English but keep original key terms (names, product words) as spoken.';

// Step 1: ids of meetings that started after `since` (ISO or null = all). Step 2: details per meeting.
// `ask`, `sleep` and `gapMs` can be replaced in tests.
export function fetchMeetings({ since, limit, model = 'haiku', onError = () => {}, projects = [], style = '', ask = askModel,
  sleep = syncSleep, gapMs = READY_GAP_MS, retries = READY_TRIES, tools = WISPR_TOOLS }) {
  let cost = 0;
  const listPrompt = `Use the Wispr Flow search_meetings tool to list ${since ? `meetings that started after ${since}` : 'all my meetings'}`
    + `${limit ? `, newest first, at most ${limit}` : ''}. Page through results until done. `
    + 'Reply ONLY with a JSON array of objects {"id","title","start"} — no prose.';
  // A headless run can start before the Wispr connector is ready ("still connecting"), and each call is a new run:
  // wait and ask again, for the list call and for every meeting call.
  const askReady = (prompt, what) => {
    let r;
    for (let attempt = 0; attempt <= retries; attempt++) {
      r = ask(prompt, { model, tools });
      cost += r.cost || 0;
      if (!(r.error && isNotReady(r.error)) || attempt === retries) break;
      onError(`wispr not ready for ${what} (try ${attempt + 1} of ${retries + 1}): ${String(r.error).slice(0, 120)}; waiting ${Math.round(gapMs / 1000)} s`);
      sleep(gapMs);
    }
    return r;
  };
  const list = askReady(listPrompt, 'the list');
  if (list.error || !Array.isArray(list.json)) {
    const notReady = isNotReady(list.error);
    return { error: `${notReady ? `Wispr connector not ready after ${retries + 1} tries` : 'list failed'}: ${list.error || 'not an array'}`.slice(0, 600), notReady, cost };
  }
  const stubs = list.json.filter((x) => x && str(x.id)
    && (!since || !utc(x.start) || Date.parse(utc(x.start)) > Date.parse(since))).slice(0, limit || Infinity);
  const meetings = [];
  const failed = [];
  for (const st of stubs) {
    const d = askReady(`Use the Wispr Flow get_meeting tool for meeting id ${st.id}. ${LANG}\n${style ? `${style}\n` : ''}${projectPromptBlock(projects)}\nReply ONLY with one JSON object: `
      + '{"id","title","start","end" (ISO 8601, convert to UTC ending in Z),"attendees":[names],"summary":"3-8 lines","project":"' + PROJECT_FIELD_HELP.replace(/"/g, "'") + '",'
      + '"decisions":[strings, empty if none],"action_items":[{"text","owner"}],"share_link"}. No prose.', `meeting ${st.id}`);
    const m = d.json && validateMeeting({ ...d.json, id: d.json.id || st.id });
    if (m) meetings.push(m); else { failed.push(`meeting ${st.id}: ${d.error || 'failed validation'}`); onError(failed.at(-1)); }
  }
  return { meetings, cost, failed };
}

// ---------- pages ----------
const listSection = (items) => items.map((x) => `- ${x}`).join('\n');

function existingPages(dir) {
  const out = {};
  const mdir = path.join(dir, 'meetings');
  if (!fs.existsSync(mdir)) return out;
  for (const f of fs.readdirSync(mdir)) {
    if (!f.endsWith('.md')) continue;
    const id = readFrontmatter(path.join(mdir, f)).wispr_id;
    if (id) out[id] = `meetings/${f}`;
  }
  return out;
}

// Values of a YAML list key (`key:\n  - "a"` or `key: []`) in page text.
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

// `user` = the Wispr user who imports it (a slug). The page lists every user who recorded the meeting in `recorded_by`.
// A page that another user recorded is not rewritten: the user is only added to the list. (A page with no list yet, from an
// older version, is rewritten as before and gets the list.) Without a `user` the page has no `recorded_by`.
export function writeMeetingPage(dir, m, { user = '' } = {}) {
  const known = existingPages(dir);
  const rel = known[m.id] || `meetings/${m.start.slice(0, 10)}-${slug(m.title)}.md`;
  const file = path.join(dir, rel);
  const isNew = !known[m.id];
  const old = isNew || !fs.existsSync(file) ? '' : fs.readFileSync(file, 'utf8');
  const recordedBy = old ? readList(old, 'recorded_by') : [];
  if (user && recordedBy.length && !recordedBy.includes(user)) {
    fs.writeFileSync(file, addToFrontmatterList(old, 'recorded_by', user));
    return { rel, isNew: false, joined: true };
  }
  const keepProject = old ? str(readFrontmatter(file).project) : '';
  const sessions = old ? readList(old, 'sessions') : [];
  const fm = frontmatter({
    type: 'Meeting', title: m.title,
    description: m.summary.split('\n')[0].replace(/^(.{200}).+$/, '$1…'),
    project: keepProject || m.project || '', wispr_id: m.id, start: m.start, end: m.end || undefined, attendees: m.attendees, link: m.link,
    tags: ['meeting'], sessions, recorded_by: user ? [...new Set([...recordedBy, user])] : undefined,
  });
  const sec = (h, body) => (body ? `\n## ${h}\n\n${body}\n` : '');
  const body = `# ${m.title}\n\n${m.summary}\n`
    + sec('Decisions', listSection(m.decisions))
    + sec('Action items', listSection(m.actions.map((a) => (a.owner ? `${a.text} (owner: ${a.owner})` : a.text))))
    + (sessions.length ? `\n## Sessions\n\n${sessions.map((s) => `- [${s}](../${s})`).join('\n')}\n` : '')
    + (m.link ? `\n---\n[Open in Wispr Flow](${m.link})\n` : '');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, redact(fm + '\n' + body));
  return { rel, isNew, joined: false };
}

// ---------- linking ----------
const pagesIn = (dir, sub) => {
  const d = path.join(dir, sub);
  return fs.existsSync(d) ? fs.readdirSync(d).filter((f) => f.endsWith('.md')).map((f) => `${sub}/${f}`) : [];
};

// Candidate pages in `sub` whose `start` is within ±days of `startIso`.
function candidates(dir, sub, startIso, days) {
  const t = Date.parse(startIso);
  return pagesIn(dir, sub).map((rel) => ({ rel, fm: readFrontmatter(path.join(dir, rel)) }))
    .filter(({ fm }) => fm.start && Math.abs(Date.parse(fm.start) - t) <= days * DAY);
}

// One cheap model call: which candidates relate to the subject? Returns [{ rel, confidence: sure|likely }].
function relate(subject, cands, { model = 'haiku', hint }) {
  if (!cands.length) return { links: [], cost: 0 };
  const list = cands.map((c, i) => `${i + 1}. ${c.fm.title || c.rel} | project: ${c.fm.project || '-'} | ${String(c.fm.start).slice(0, 16)} | ${c.fm.description || ''}`).join('\n');
  const r = askModel(`${hint}\nSUBJECT: ${subject}\nCANDIDATES:\n${list}\n`
    + '"sure" = the candidate clearly opened, named or directly worked on the subject. "likely" = same project and topic. '
    + 'Skip anything else. Reply ONLY with a JSON array like [{"n":1,"confidence":"sure"}] ([] if none).', { model });
  if (r.error || !Array.isArray(r.json)) return { links: [], cost: r.cost || 0, error: r.error || 'not an array' };
  const links = r.json.filter((x) => cands[x?.n - 1] && /^(sure|likely)$/.test(x.confidence))
    .map((x) => ({ rel: cands[x.n - 1].rel, confidence: x.confidence }));
  return { links, cost: r.cost || 0 };
}

// Meeting → sessions within ±days.
export function findRelatedSessions(dir, meeting, { days = 7, model } = {}) {
  const cands = candidates(dir, 'sessions', meeting.start, days);
  return relate(`meeting "${meeting.title}" — ${meeting.summary.slice(0, 600)}`, cands,
    { model, hint: 'Which agent work sessions relate to this meeting?' });
}

// Session → meetings within ±days (reverse direction; capture can call this).
export function findRelatedMeetings(dir, session, { days = 7, model } = {}) {
  const cands = candidates(dir, 'meetings', session.start, days);
  return relate(`session "${session.title}" (project ${session.project || '-'}) — ${session.description || ''}`, cands,
    { model, hint: 'Which meetings relate to this agent work session?' });
}

// Add `entry` to the YAML list `key` of a page (create the key if missing), keep everything else.
function addToFrontmatterList(text, key, entry) {
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return text;
  const lines = m[1].split('\n');
  const i = lines.findIndex((l) => l.startsWith(`${key}:`));
  const item = `  - ${JSON.stringify(entry)}`;
  if (i < 0) lines.push(`${key}:`, item);
  else {
    if (lines[i].trim() === `${key}: []`) lines[i] = `${key}:`;
    let j = i + 1;
    while (j < lines.length && /^\s+- /.test(lines[j])) { if (lines[j] === item) return text; j++; }
    lines.splice(j, 0, item);
  }
  return `---\n${lines.join('\n')}\n---${text.slice(m[0].length)}`;
}

// Add a link line under "## <heading>" (created before the footer rule if absent).
function addBodyLink(text, heading, line) {
  if (text.includes(line)) return text;
  const h = `\n## ${heading}\n`;
  const i = text.indexOf(h);
  if (i >= 0) {
    const after = i + h.length;
    const next = text.slice(after).search(/\n(## |---\n)/);
    const end = next < 0 ? text.length : after + next;
    const sec = text.slice(after, end).replace(/\s+$/, '');
    return text.slice(0, after) + (sec ? sec + '\n' : '\n') + line + '\n' + text.slice(end);
  }
  const foot = text.lastIndexOf('\n---\n');
  const block = `\n## ${heading}\n\n${line}\n`;
  return foot > 0 ? text.slice(0, foot) + block + text.slice(foot) : text.replace(/\s*$/, '\n') + block;
}

// Write the links both ways. `links` = [{ rel, confidence }] of session pages for meeting `meetingRel`.
export function linkMeetingSessions(dir, meetingRel, links) {
  const mfile = path.join(dir, meetingRel);
  const mtitle = readFrontmatter(mfile).title || meetingRel;
  for (const l of links) {
    const sfile = path.join(dir, l.rel);
    if (!fs.existsSync(sfile)) continue;
    const stitle = readFrontmatter(sfile).title || l.rel;
    let m = fs.readFileSync(mfile, 'utf8');
    m = addToFrontmatterList(m, 'sessions', l.rel);
    m = addBodyLink(m, 'Sessions', `- [${stitle}](../${l.rel}) — ${l.confidence}`);
    fs.writeFileSync(mfile, redact(m));
    let s = fs.readFileSync(sfile, 'utf8');
    s = addToFrontmatterList(s, 'meetings', meetingRel);
    s = addBodyLink(s, 'Meetings', `- [${mtitle}](../${meetingRel}) — ${l.confidence}`);
    fs.writeFileSync(sfile, redact(s));
  }
}

// Whole import. Returns a summary object. Caller handles state + sync.
// `newest` = start of the newest meeting seen; a meeting that could not be read goes into `errors`.
export function importMeetings(dir, { since, limit, dryRun, model, log = () => {}, style = '', ask, sleep, gapMs, tools, user = '' }) {
  const projects = listProjects(dir);
  const f = fetchMeetings({ since, limit, model, onError: log, projects, style, ask, sleep, gapMs, tools });
  if (f.error) return { error: f.error, cost: f.cost };
  const out = { cost: f.cost, pages: [], errors: [...f.failed], newest: f.meetings.map((m) => m.start).sort().at(-1) || null };
  // Meetings removed on purpose (e.g. hiring) are listed in .agent-wiki/skip-meetings.json and never re-imported.
  const skipFile = path.join(dir, '.agent-wiki', 'skip-meetings.json');
  const skip = new Set(fs.existsSync(skipFile) ? JSON.parse(fs.readFileSync(skipFile, 'utf8')) : []);
  for (const m of f.meetings) {
    if (skip.has(m.id)) { log(`skip meeting ${m.id} (in skip-meetings.json)`); continue; }
    if (dryRun) { out.pages.push({ title: m.title, start: m.start, dry: true }); continue; }
    const pa = parseProjectAnswer(m.projectAnswer, projects);
    if (pa.newProject) { createProjectPage(dir, pa.newProject); projects.push({ ...pa.newProject, aliases: [] }); }
    m.project = pa.project;
    const { rel, isNew, joined } = writeMeetingPage(dir, m, { user });
    const entry = { rel, isNew, start: m.start, links: [] };
    if (joined) entry.joined = user;
    if (isNew) {
      const r = findRelatedSessions(dir, m, { model });
      out.cost += r.cost || 0;
      if (r.error) out.errors.push(`${rel}: link ${r.error}`);
      linkMeetingSessions(dir, rel, r.links);
      entry.links = r.links;
    }
    out.pages.push(entry);
  }
  return out;
}
