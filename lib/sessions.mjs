// Read Claude Code, Codex and Antigravity (agy) session records into one plain shape.
//   { tool, id, file, cwd, model, headless, events: [{id, ts, role, text, tool}], marker, finished }
import fs from 'node:fs';
import path from 'node:path';
import { HOME } from './config.mjs';
import { newHarvest, harvest, noteToolCall, toolCreated, textsOf } from './outputs.mjs';

const CLAUDE_DIR = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(HOME, '.claude'), 'projects');
const CODEX_DIR = path.join(process.env.CODEX_HOME || path.join(HOME, '.codex'), 'sessions');
const AGY_DIR = process.env.AGY_HOME || path.join(HOME, '.gemini', 'antigravity-cli');
const MARKER = /agent-wiki\s+set\s+([\w-]+)/g;

const readLines = (file) =>
  fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap((l) => {
    try { return [JSON.parse(l)]; } catch { return []; }
  });

function lastMarker(text, current) {
  let m;
  let found = current;
  MARKER.lastIndex = 0;
  while ((m = MARKER.exec(text))) found = m[1];
  return found;
}

// ---------- Claude Code ----------
export function claudeFile(id) {
  if (!fs.existsSync(CLAUDE_DIR)) return null;
  for (const dir of fs.readdirSync(CLAUDE_DIR)) {
    const f = path.join(CLAUDE_DIR, dir, `${id}.jsonl`);
    if (fs.existsSync(f)) return f;
  }
  return null;
}

export function listClaudeFiles(sinceMs) {
  if (!fs.existsSync(CLAUDE_DIR)) return [];
  const out = [];
  for (const dir of fs.readdirSync(CLAUDE_DIR)) {
    const d = path.join(CLAUDE_DIR, dir);
    if (!fs.statSync(d).isDirectory()) continue;
    for (const f of fs.readdirSync(d)) {
      if (!f.endsWith('.jsonl')) continue;
      const p = path.join(d, f);
      if (fs.statSync(p).mtimeMs >= sinceMs) out.push(p);
    }
  }
  return out;
}

export function readClaude(file) {
  const rows = readLines(file);
  const s = { tool: 'claude', id: path.basename(file, '.jsonl'), file, cwd: null, model: null,
    headless: false, events: [], marker: null, finished: false, harvest: newHarvest() };
  const h = s.harvest;
  const scan = (v, ts, opts) => { for (const t of textsOf(v)) harvest(h, t, { ts, cwd: s.cwd || '', ...opts }); };
  for (const r of rows) {
    if (r.isSidechain) continue;
    if (r.cwd) s.cwd = r.cwd;
    if (r.entrypoint && r.entrypoint.startsWith('sdk')) s.headless = true;
    if (r.type !== 'user' && r.type !== 'assistant') continue;
    const m = r.message || {};
    const blocks = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content || [];
    if (r.type === 'assistant') {
      if (m.model && !m.model.startsWith('<')) s.model = m.model;
      for (const b of blocks) {
        if (b.type === 'text' && b.text.trim()) { s.events.push({ id: r.uuid, ts: r.timestamp, role: 'assistant', text: b.text }); scan(b.text, r.timestamp, { from: 'text' }); }
        if (b.type === 'tool_use') {
          noteToolCall(h, b.id, b.name, b.input);
          scan(b.input, r.timestamp, { from: 'input' });
          const input = JSON.stringify(b.input || {});
          s.marker = lastMarker(input, s.marker);
          s.events.push({ id: r.uuid, ts: r.timestamp, role: 'tool', tool: b.name, text: input.slice(0, 300) });
        }
      }
      s.finished = ['end_turn', 'stop_sequence'].includes(m.stop_reason);
    } else {
      for (const b of blocks) if (b.type === 'tool_result') scan(b.content, r.timestamp, { from: 'result', created: toolCreated(h, b.tool_use_id) });
      if (r.isMeta) continue;
      const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
      if (!text || blocks.some((b) => b.type === 'tool_result')) continue;
      s.events.push({ id: r.uuid, ts: r.timestamp, role: 'user', text });
      s.finished = false;
    }
  }
  return s;
}

// ---------- Codex ----------
export function listCodexFiles(sinceMs) {
  const out = [];
  const walk = (d) => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.startsWith('rollout-') && e.name.endsWith('.jsonl') && fs.statSync(p).mtimeMs >= sinceMs) out.push(p);
    }
  };
  walk(CODEX_DIR);
  return out;
}

export function codexFile(id) {
  return listCodexFiles(0).find((f) => f.includes(id)) || null;
}

export function readCodex(file) {
  const rows = readLines(file);
  const s = { tool: 'codex', id: null, file, cwd: null, model: null, headless: false,
    events: [], marker: null, finished: false, harvest: newHarvest() };
  const h = s.harvest;
  const scan = (v, ts, opts) => { for (const t of textsOf(v)) harvest(h, t, { ts, cwd: s.cwd || '', ...opts }); };
  rows.forEach((r, i) => {
    const p = r.payload || {};
    if (r.type === 'session_meta') {
      s.id = p.id || p.session_id;
      s.cwd = p.cwd;
      s.headless = p.originator === 'codex_exec' || p.source === 'exec';
    }
    if (r.type === 'turn_context' && p.model) s.model = p.model;
    if (r.type !== 'response_item') return;
    const id = String(i);
    if (p.type === 'message' && (p.role === 'user' || p.role === 'assistant')) {
      const text = (p.content || []).map((c) => c.text || '').join('\n').trim();
      if (!text || (p.role === 'user' && text.startsWith('<'))) return;
      s.events.push({ id, ts: r.timestamp, role: p.role, text });
      if (p.role === 'assistant') scan(text, r.timestamp, { from: 'text' });
      s.finished = p.role === 'assistant';
    } else if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') {
      scan(p.output, r.timestamp, { from: 'result', created: toolCreated(h, p.call_id) });
    } else if (p.type === 'function_call' || p.type === 'custom_tool_call') {
      const input = p.arguments || p.input || '';
      noteToolCall(h, p.call_id, p.name, { command: String(input) });
      scan(String(input), r.timestamp, { from: 'input' });
      s.marker = lastMarker(String(input), s.marker);
      s.events.push({ id, ts: r.timestamp, role: 'tool', tool: p.name, text: String(input).slice(0, 300) });
      s.finished = false;
    }
  });
  return s;
}

// ---------- Antigravity CLI (agy) ----------
// agy keeps one SQLite file per conversation: <AGY_DIR>/conversations/<uuid>.db (WAL mode).
// Table `steps` (idx, step_type, metadata, step_payload) holds protobuf blobs with the REAL turns:
//   step_type 14  user input       payload field 19 → field 2 = text (wrapped in <USER_REQUEST>…)
//   step_type 15  model response   payload field 20 → field 8 = reply text, field 7 (repeated) =
//                                  tool call { 1: call id, 2: tool name, 3: JSON arguments }
//   step_type 21  a question the user answered in the TUI (never occurs in print mode)
//   other types (132 tool result, 101, …) are skipped.
// step `metadata` field 1 = created-at {1: seconds, 2: nanos}. The model name is in the table
// `executor_metadata` (field 10 → 1 → 28). The folder is step 0's payload field 19 → 12 → 12 (file:// URI).
// Shell commands are tool calls named `run_command` with JSON arguments {"CommandLine": …}, so the
// `agent-wiki set <vault>` marker is read from those, like Claude's Bash tool_use.
// We use no protobuf library: a 25-line wire reader below is enough.
//
// Print mode (`agy -p`, used by the review loop) leaves NO flag in the conversation (checked on 195
// conversations: the same fields appear in both modes), so headless is INFERRED the other way round:
// a conversation is interactive only if (a) <AGY_DIR>/history.jsonl, which only the TUI writes,
// holds its id (or an id-less first-prompt line with the same text and time), or (b) it has a
// step_type 21. Everything else is headless. Limit: if the TUI stops writing history.jsonl, its
// sessions would read as headless (set include_headless=true to keep them).
const wireItems = (buf) => {
  const out = [];
  let i = 0;
  const varint = () => {
    let r = 0, mul = 1, b;
    do { b = buf[i++]; r += (b & 127) * mul; mul *= 128; } while (b & 128);
    return r;
  };
  while (i < buf.length) {
    const key = varint();
    const f = Math.floor(key / 8), w = key % 8;
    if (w === 0) out.push([f, varint()]);
    else if (w === 2) { const n = varint(); out.push([f, buf.subarray(i, i + n)]); i += n; }
    else if (w === 1) { out.push([f, buf.subarray(i, i + 8)]); i += 8; }
    else if (w === 5) { out.push([f, buf.subarray(i, i + 4)]); i += 4; }
    else throw new Error('bad protobuf');
  }
  return out;
};
const pb = (buf, ...fields) => {   // first submessage/field along the path, or null
  let cur = buf;
  for (const f of fields) {
    if (!cur || typeof cur === 'number') return null;
    let items;
    try { items = wireItems(cur); } catch { return null; }
    const hit = items.find(([k]) => k === f);
    cur = hit ? hit[1] : null;
  }
  return cur;
};
const pbAll = (buf, f) => { try { return wireItems(buf).filter(([k]) => k === f).map(([, v]) => v); } catch { return []; } };
const pbText = (v) => (Buffer.isBuffer(v) ? v.toString('utf8') : '');
const pbTime = (meta) => {
  const t = pb(meta, 1);
  if (!t) return null;
  const s = pb(t, 1), n = pb(t, 2);
  return typeof s === 'number' ? new Date(s * 1000 + (typeof n === 'number' ? n / 1e6 : 0)).toISOString() : null;
};

// Size of agy's write-ahead log: > 0 means a running agy still holds recent turns there.
const walSize = (f) => (fs.existsSync(`${f}-wal`) ? fs.statSync(`${f}-wal`).size : 0);

// Never create files in agy's folder: a plain read-only open of a WAL database creates -shm/-wal
// files and bumps their mtime (which would also make every session look active). So open with
// immutable=1 (no side effects) unless a non-empty -wal exists, then read it normally to see it.
function openAgy(file) {
  // node:sqlite prints an "experimental" warning on load; hide only that one.
  const orig = process.emitWarning;
  process.emitWarning = (w, ...a) => (/SQLite/i.test(String(w)) ? undefined : orig.call(process, w, ...a));
  try {
    const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
    return new DatabaseSync(`file:${file}?${walSize(file) > 0 ? 'mode=ro' : 'immutable=1'}`, { readOnly: true });
  } finally { process.emitWarning = orig; }
}

export const agyFile = (id) => {
  const f = path.join(AGY_DIR, 'conversations', `${id}.db`);
  return fs.existsSync(f) ? f : null;
};

// Newest write time of a session file; agy's recent writes sit in the -wal file first
// (an empty -wal only means someone opened the database, so it does not count).
export function fileMtime(f) {
  const wal = `${f}-wal`;
  return Math.max(fs.statSync(f).mtimeMs, walSize(f) > 0 ? fs.statSync(wal).mtimeMs : 0);
}

export function listAgyFiles(sinceMs) {
  const dir = path.join(AGY_DIR, 'conversations');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.db')).map((f) => path.join(dir, f))
    .filter((p) => fileMtime(p) >= sinceMs);
}

function agyHistory() {
  const f = path.join(AGY_DIR, 'history.jsonl');
  return fs.existsSync(f) ? readLines(f) : [];
}

const agyUserText = (raw) => {
  const m = /<USER_REQUEST>\n?([\s\S]*?)\n?<\/USER_REQUEST>/.exec(raw);
  return (m ? m[1] : raw).trim();
};

export function readAgy(file) {
  const id = path.basename(file, '.db');
  const s = { tool: 'agy', id, file, cwd: null, model: null, headless: true, events: [], marker: null, finished: false,
    harvest: newHarvest() };
  const db = openAgy(file);
  let steps;
  try {
    steps = db.prepare('select idx, step_type, metadata, step_payload from steps order by idx').all();
    const ex = db.prepare('select data from executor_metadata').get();
    const model = ex && pbText(pb(ex.data && Buffer.from(ex.data), 10, 1, 28));
    if (model) s.model = model;
  } finally { db.close(); }

  let interactive = false;
  for (const st of steps) {
    const payload = Buffer.from(st.step_payload || []);
    const meta = Buffer.from(st.metadata || []);
    const ts = pbTime(meta);
    if (st.step_type === 21) interactive = true;
    if (st.step_type === 14) {
      const raw = pbText(pb(payload, 19, 2));
      if (!s.cwd) {
        const uri = pbText(pb(payload, 19, 12, 12));
        if (uri.startsWith('file://')) s.cwd = decodeURIComponent(uri.slice(7));
      }
      const text = agyUserText(raw);
      if (!text) continue;
      s.events.push({ id: String(st.idx), ts, role: 'user', text });
      s.finished = false;
    } else if (st.step_type === 15) {
      const body = pb(payload, 20);
      if (!body) continue;
      const reply = pbText(pb(body, 8)).trim();
      if (reply) { s.events.push({ id: String(st.idx), ts, role: 'assistant', text: reply }); s.finished = true; harvest(s.harvest, reply, { ts, from: 'text', cwd: s.cwd || '' }); }
      pbAll(body, 7).forEach((call, n) => {
        const name = pbText(pb(call, 2));
        const args = pbText(pb(call, 3));
        if (name === 'run_command') s.marker = lastMarker(args, s.marker);
        harvest(s.harvest, args, { ts, from: 'input', cwd: s.cwd || '' });
        s.events.push({ id: `${st.idx}.${n}`, ts, role: 'tool', tool: name, text: args.slice(0, 300) });
        s.finished = false;
      });
    }
  }

  if (!s.cwd) {
    const f = path.join(AGY_DIR, 'conversation_summaries.db');
    if (fs.existsSync(f)) {
      const d = openAgy(f);
      try {
        const r = d.prepare('select workspace_uris u from conversation_summaries where conversation_id = ?').get(id);
        const uri = r && JSON.parse(r.u)[0];
        if (uri && uri.startsWith('file://')) s.cwd = decodeURIComponent(uri.slice(7));
      } catch { /* no summary row */ } finally { d.close(); }
    }
  }

  if (!interactive) {
    const first = s.events.find((e) => e.role === 'user');
    const t0 = Date.parse(first?.ts || 0);
    interactive = agyHistory().some((h) => h.conversationId === id
      || (!h.conversationId && first && agyUserText(h.display || '') === first.text && Math.abs(h.timestamp - t0) < 600_000));
  }
  s.headless = !interactive;
  return s;
}

export function readSession(tool, file) {
  return tool === 'codex' ? readCodex(file) : tool === 'agy' ? readAgy(file) : readClaude(file);
}

export function findSession(tool, id) {
  const file = tool === 'codex' ? codexFile(id) : tool === 'agy' ? agyFile(id) : claudeFile(id);
  return file ? readSession(tool, file) : null;
}

// Events after the anchor (the last event already captured).
export function eventsAfter(s, anchor) {
  if (!anchor) return s.events;
  const i = s.events.findLastIndex((e) => e.id === anchor);
  return i < 0 ? s.events : s.events.slice(i + 1);
}

export const userTurns = (s) => s.events.filter((e) => e.role === 'user').length;
export const lastEvent = (s) => s.events.at(-1);

// Plain transcript text for the fallback summariser (prose + tool names only).
export function transcriptText(events, maxChars = 150_000) {
  const lines = events.map((e) =>
    e.role === 'tool' ? `[tool: ${e.tool}]` : `${e.role.toUpperCase()}: ${e.text}`);
  const text = lines.join('\n\n');
  if (text.length <= maxChars) return text;
  // Keep the start (the task and early decisions) and the end (the result).
  const head = Math.floor(maxChars * 0.3);
  return text.slice(0, head) + '\n\n…(middle part cut)…\n\n' + text.slice(-(maxChars - head));
}
