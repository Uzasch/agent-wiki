// Is this machine logged in to Wispr Flow, and under which tool names?
// Wispr is an MCP server that `claude mcp list` shows. It is either the claude.ai connector
// ("claude.ai Wispr Flow") or a server added by hand with `claude mcp add` (any name, e.g. "wispr").
// The tool names depend on that server name, so they are read from the list, not guessed.
import { spawnSync } from 'node:child_process';
import os from 'node:os';

export const WISPR_URL = 'wisprflow.ai/connect/mcp';
export const LOGIN_TRIES = 3;        // re-checks while a Wispr server is listed but still connecting
export const LOGIN_GAP_MS = 45_000;
export const DEFAULT_PREFIX = 'mcp__claude_ai_Wispr_Flow__';
const syncSleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// Claude Code's rule: every character of the server name that is not a letter, digit, "_" or "-" becomes "_".
export const toolPrefix = (serverName) => `mcp__${String(serverName).replace(/[^A-Za-z0-9_-]/g, '_')}__`;

// Config override `wispr_tool_prefix`: "claude_ai_Wispr_Flow" and "mcp__claude_ai_Wispr_Flow__" both work.
export const normalizePrefix = (p) => {
  const inner = String(p || '').trim().replace(/^mcp__/, '').replace(/__$/, '');
  return inner ? `mcp__${inner}__` : '';
};

export const wisprTools = (prefix = DEFAULT_PREFIX) => [`${prefix}search_meetings`, `${prefix}get_meeting`];

// Lines of `claude mcp list` that point at Wispr: "<name>: <url> - <status>". Returns [{ name, status, connected }].
export function parseMcpList(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    if (!line.includes(WISPR_URL)) continue;
    const m = line.match(/^(.+?):\s+(\S+)\s+(?:\([^)]*\)\s+)?-\s+(.*?)\s*$/);   // a direct HTTP server has "(HTTP)" after the URL
    if (!m || !m[2].includes(WISPR_URL)) continue;
    out.push({ name: m[1].trim(), status: m[3], connected: /^\W*Connected$/i.test(m[3]) });
  }
  return out;
}

// Several Wispr servers can be listed at once (the connector and a direct one, one of them maybe not signed in).
// Only a connected one counts; a direct server is preferred over the claude.ai connector.
export function pickWispr(servers) {
  const ok = servers.filter((s) => s.connected);
  return ok.find((s) => !s.name.startsWith('claude.ai ')) || ok[0] || null;
}

export function runMcpList({ timeout = 60_000 } = {}) {
  const r = spawnSync('claude', ['mcp', 'list'], { encoding: 'utf8', timeout, input: '', env: { ...process.env, AGENT_WIKI_RUNNING: '1' } });
  if (r.error?.code === 'ENOENT') return { missing: true };
  if (r.error) return { error: `claude mcp list: ${r.error.message}` };
  if (r.status !== 0) return { error: `claude mcp list exit ${r.status}: ${(r.stderr || '').slice(0, 300)}` };
  return { stdout: `${r.stdout || ''}\n${r.stderr || ''}` };
}

// Returns { state: 'ok', name, status, prefix } | { state: 'none', reason } | { state: 'error', error }.
// A server that is listed but still connecting is re-checked (`tries` times, `gapMs` apart); one that
// "needs authentication", or none at all, means this machine has no login. `run` and `sleep` are replaceable in tests.
export function wisprLogin({ run = runMcpList, sleep = syncSleep, tries = LOGIN_TRIES, gapMs = LOGIN_GAP_MS, prefix, onWait = () => {} } = {}) {
  for (let attempt = 0; ; attempt++) {
    const r = run();
    if (r.missing) return { state: 'none', reason: 'the claude command is not installed' };
    if (r.error) return { state: 'error', error: r.error };
    const servers = parseMcpList(r.stdout);
    const hit = pickWispr(servers);
    if (hit) return { state: 'ok', name: hit.name, status: hit.status, prefix: normalizePrefix(prefix) || toolPrefix(hit.name) };
    const connecting = servers.some((s) => !/needs authentication/i.test(s.status));
    if (!connecting || attempt >= tries) {
      return { state: 'none', reason: servers.length ? servers.map((s) => `${s.name}: ${s.status}`).join('; ') : 'no Wispr Flow server in claude mcp list' };
    }
    onWait(`wispr server not connected yet (${servers.map((s) => s.status).join('; ')}); check ${attempt + 1} of ${tries + 1}, waiting ${Math.round(gapMs / 1000)} s`);
    sleep(gapMs);
  }
}

// ---------- who is this Wispr user? ----------
// Meetings belong to a person, not to a vault: each person has their own Wispr login, and the run record in the vault
// is one file per person. The name must be known BEFORE the import starts (the record is checked first), so it cannot come
// from the import's own model call. Order: config `wispr_user`, then `git config --global user.email`, then the OS user name.

// Lowercase letters, digits and "-" only: safe as a file name and as a `recorded_by` value. '' if nothing is left.
export const userSlug = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/, '');

const gitEmail = () => {
  const r = spawnSync('git', ['config', '--global', 'user.email'], { encoding: 'utf8', timeout: 10_000 });
  return r.status === 0 ? r.stdout.trim() : '';
};
const osName = () => { try { return os.userInfo().username; } catch { return process.env.USER || process.env.USERNAME || ''; } };

// Returns { slug, source, raw }. `git` and `osUser` are replaceable in tests.
export function wisprUser(cfg = {}, { git = gitEmail, osUser = osName } = {}) {
  const tries = [['config wispr_user', () => cfg.wispr_user], ['git config --global user.email', git], ['OS user name', osUser]];
  for (const [source, get] of tries) {
    const raw = String(get() ?? '').trim();
    const slug = userSlug(raw);
    if (slug) return { slug, source, raw };
  }
  return { slug: 'unknown-user', source: 'default (no name found)', raw: '' };
}
