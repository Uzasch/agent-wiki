#!/usr/bin/env node
// agent-wiki — capture agent sessions into git-backed OKF vaults.
import fs from 'node:fs';
import path from 'node:path';

// The prompt hook runs on every user prompt, so it is handled first, before the heavy modules load.
if (process.argv[2] === 'hook' && /-prompt$/.test(process.argv[3] || '')) {
  const { promptHook } = await import('../lib/hook.mjs');
  await promptHook();
  process.exit(0);
}

const { spawn, spawnSync } = await import('node:child_process');
const { fileURLToPath } = await import('node:url');
const { loadConfig, saveConfig, resolveVault, rememberFolder, vaultPath, STATE_DIR, expand } = await import('../lib/config.mjs');
const { readSession, findSession, listClaudeFiles, listCodexFiles, listAgyFiles, fileMtime, eventsAfter, userTurns, lastEvent, transcriptText } = await import('../lib/sessions.mjs');
const { summarise } = await import('../lib/summarise.mjs');
const { initVault, writeSessionPage, findSessionPage, syncVault } = await import('../lib/vault.mjs');
const { listProjects, createProjectPage, organizeVault } = await import('../lib/projects.mjs');
const { withLock, withLockAsync } = await import('../lib/lock.mjs');
const { importClaudeMem } = await import('../lib/claudemem.mjs');
const { addImage, pullImages } = await import('../lib/drive.mjs');
const { importMeetings } = await import('../lib/meetings.mjs');
const { finalizeOutputs, pickImages } = await import('../lib/outputs.mjs');
const { buildScreenshots } = await import('../lib/screenshots.mjs');
const { planRenames, applyRenames, renameInState, brokenLinks } = await import('../lib/migrate.mjs');

const SELF = fileURLToPath(import.meta.url);
const STATE_FILE = path.join(STATE_DIR, 'sessions.json');
const LOG_FILE = path.join(STATE_DIR, 'agent-wiki.log');

const log = (msg) => {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${msg}\n`);
};
const loadState = () => (fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) : {});
const saveState = (st) => {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE + '.tmp', JSON.stringify(st, null, 1));
  fs.renameSync(STATE_FILE + '.tmp', STATE_FILE);
};
const updateState = (key, value) => { const st = loadState(); st[key] = { ...st[key], ...value }; saveState(st); };

function installedAt() {
  const f = path.join(STATE_DIR, 'installed_at');
  if (!fs.existsSync(f)) { fs.mkdirSync(STATE_DIR, { recursive: true }); fs.writeFileSync(f, String(Date.now())); }
  return Number(fs.readFileSync(f, 'utf8'));
}

function flag(args, name) {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  args.splice(i, v && !v.startsWith('--') ? 2 : 1);
  return v && !v.startsWith('--') ? v : true;
}

// ---------- capture one session ----------
async function capture(s, { force = false, fresh = false } = {}) {
  const cfg = loadConfig();
  const key = `${s.tool}:${s.id}`;
  if (s.headless && !cfg.include_headless) return { skip: 'headless' };
  const vaultName = resolveVault(cfg, s.cwd || '', s.marker);
  if (vaultName === 'off') return { skip: 'off' };
  const dir = vaultPath(cfg, vaultName);
  if (!dir) return { error: `unknown vault "${vaultName}" — add it with: agent-wiki vault new ${vaultName} <owner/repo>` };
  if (userTurns(s) < cfg.min_turns && !force) return { skip: 'short' };
  const prev = loadState()[key];
  const fresh_ = eventsAfter(s, prev?.anchor);
  if (!fresh_.length && !force) return { skip: 'nothing new' };

  // A copy of the session is cheap only while its prompt cache (~1 h) is warm.
  // capture_mode: "fresh" (cheap model reads text, default) | "fork-warm" | "fork-long".
  const coldCache = Date.now() - Date.parse(lastEvent(s)?.ts || 0) > 55 * 60_000;
  const long = transcriptText(s.events, Infinity).length > 150_000;
  const mode = cfg.capture_mode;
  const useFork = !fresh && s.tool !== 'agy' && !coldCache && (mode === 'fork-warm' || (mode === 'fork-long' && long));
  let projects = [];
  const res = await withLockAsync(`session-${key}`, async () => {
    if (fs.existsSync(dir)) projects = listProjects(dir);
    const sum = summarise(s, s.events, { since: prev?.at, fallbackModel: cfg.fallback_model, preferFresh: !useFork, projects, allowSkip: userTurns(s) < 5 });
    if (sum.error) return { error: sum.error };
    const anchor = lastEvent(s)?.id;
    if (sum.skip) { updateState(key, { anchor, at: new Date().toISOString(), skipped: true }); return { skip: 'model said SKIP' }; }
    if (!fs.existsSync(dir)) initVault(dir);
    if (sum.newProject) createProjectPage(dir, sum.newProject);
    // Deterministic outputs: links and NAS paths found in the raw record; screenshots go to Drive when the vault has one.
    const outputs = s.harvest ? finalizeOutputs(s.harvest) : [];
    let screenshots = '';
    if (s.harvest && cfg.vaults[vaultName]?.drive) {
      try {
        const old = findSessionPage(dir, s);
        screenshots = await buildScreenshots({ images: pickImages(s.harvest), vault: cfg.vaults[vaultName], vaultName, vaultDir: dir,
          session: s, existing: old ? fs.readFileSync(path.join(dir, old), 'utf8') : '', log });
      } catch (e) { log(`screenshots failed for ${key}: ${String(e.message || e).slice(0, 200)}`); }
    }
    const page = writeSessionPage(dir, s, sum, { machine: cfg.machine, vaultName, outputs, screenshots });
    const sync = syncVault(dir, `session: ${sum.title}`.slice(0, 120));
    updateState(key, { anchor, at: new Date().toISOString(), vault: vaultName, page, skipped: false,
      error: sync.ok ? null : sync.error });
    return { page, vault: vaultName, how: sum.how, cost: sum.cost, cached: sum.cached, sync, outputs: outputs.length, screenshots: (screenshots.match(/!\[/g) || []).length };
  });
  return res.locked ? { skip: 'already capturing' } : res.value;
}

// Organize one vault, never throw. Logs the result.
function organizeSafe(vaultName, { all = false } = {}) {
  try {
    const cfg = loadConfig();
    const dir = vaultPath(cfg, vaultName);
    if (!dir || !fs.existsSync(dir)) return { error: `unknown vault "${vaultName}"` };
    const r = organizeVault(dir, { vaultKey: vaultName, stateDir: STATE_DIR, all, model: cfg.fallback_model, log });
    log(`organize ${vaultName} ${JSON.stringify(r)}`);
    return r;
  } catch (e) {
    log(`organize ${vaultName} failed: ${e.message}`);
    return { error: e.message };
  }
}

// ---------- commands ----------
const cmds = {
  // /set-wiki: the skill runs this; the capture job finds it in the session record.
  set(args) {
    const remember = flag(args, '--remember');
    const name = args[0];
    const cfg = loadConfig();
    if (!name) {
      console.log(`default: ${cfg.default}\nthis folder: ${resolveVault(cfg, process.cwd(), null)}\nvaults: ${Object.keys(cfg.vaults).join(', ') || '(none)'}`);
      return;
    }
    if (name !== 'off' && !cfg.vaults[name]) {
      console.error(`unknown vault "${name}". Known: ${Object.keys(cfg.vaults).join(', ') || '(none)'}. Add: agent-wiki vault new ${name} <owner/repo>`);
      process.exit(1);
    }
    if (remember) rememberFolder(cfg, process.cwd(), name);
    console.log(`agent-wiki: this session → ${name}${remember ? ` (and saved for ${process.cwd()})` : ''}`);
  },

  vault(args) {
    const pathFlag = flag(args, '--path');
    const [sub, name, repo] = args;
    const cfg = loadConfig();
    if (sub === 'list' || !sub) {
      for (const [n, v] of Object.entries(cfg.vaults)) console.log(`${n}\t${v.repo || '(local)'}\t${vaultPath(cfg, n)}`);
      return;
    }
    if (sub !== 'new' || !name) { console.error('usage: agent-wiki vault new <name> [<owner/repo>] [--path DIR]'); process.exit(1); }
    const dir = expand(pathFlag || `~/wikis/${name}`);
    if (repo && !fs.existsSync(dir)) {
      const r = spawnSync('git', ['clone', '-q', `git@github.com:${repo}.git`, dir], { stdio: 'inherit' });
      if (r.status !== 0) process.exit(1);
    }
    initVault(dir);
    cfg.vaults[name] = { ...(repo ? { repo } : {}), path: dir.replace(process.env.HOME, '~') };
    saveConfig(cfg);
    const sync = syncVault(dir, 'init vault');
    console.log(`vault ${name} → ${dir} ${sync.ok ? '' : `(sync: ${sync.error})`}`);
  },

  async 'import-claude-mem'(args) {
    const name = flag(args, '--vault');
    const db = flag(args, '--db');
    const dryRun = !!flag(args, '--dry-run');
    if (!name || name === true) { console.error('usage: agent-wiki import-claude-mem --vault <name> [--db PATH] [--dry-run]'); process.exit(1); }
    const cfg = loadConfig();
    const dir = vaultPath(cfg, name);
    if (!dir) { console.error(`unknown vault "${name}"`); process.exit(1); }
    const r = await importClaudeMem({ db: db || undefined, vaultDir: dir, dryRun });
    console.log(`${dryRun ? 'dry run: ' : ''}${r.pages} pages, ${(r.bytes / 1e6).toFixed(1)} MB, kept ${r.kept}/${r.observations} observations, ${r.summaries} summaries, skipped ${r.skipped} (${r.skippedTypes.length} types)`);
    if (!dryRun) syncVault(dir, 'import claude-mem history');
  },

  // Images: upload to the vault's Drive, keep a local copy in _drive/, print the markdown to paste.
  async image(args) {
    const name = flag(args, '--name');
    const [sub, vaultName, file] = args;
    if (sub !== 'add' || !vaultName || !file) { console.error('usage: agent-wiki image add <vault> <file> [--name N]'); process.exit(1); }
    const cfg = loadConfig();
    const dir = vaultPath(cfg, vaultName);
    if (!dir) { console.error(`unknown vault "${vaultName}"`); process.exit(1); }
    try {
      const r = await addImage({ vault: cfg.vaults[vaultName], vaultName, vaultDir: dir, file: path.resolve(file), name: name || undefined });
      console.log(r.markdown);
    } catch (e) { console.error(`image add failed: ${e.message}`); process.exit(1); }
  },

  // Drive: pull images that pages reference but this machine does not have yet.
  async drive(args) {
    const [sub, vaultName] = args;
    if (sub !== 'pull' || !vaultName) { console.error('usage: agent-wiki drive pull <vault>'); process.exit(1); }
    const cfg = loadConfig();
    const dir = vaultPath(cfg, vaultName);
    if (!dir) { console.error(`unknown vault "${vaultName}"`); process.exit(1); }
    try {
      const r = await pullImages({ vault: cfg.vaults[vaultName], vaultName, vaultDir: dir });
      console.log(`pulled ${r.pulled.length}${r.pulled.map((x) => `\n  + ${x}`).join('')}${r.missing.map((x) => `\n  ! not on Drive: ${x}`).join('')}`);
      if (r.missing.length) process.exit(1);
    } catch (e) { console.error(`drive pull failed: ${e.message}`); process.exit(1); }
  },

  async capture(args) {
    const tool = flag(args, '--tool') || 'claude';
    const id = flag(args, '--id');
    const file = flag(args, '--file');
    const s = file ? readSession(tool, file) : findSession(tool, id);
    if (!s) { console.error('session not found'); process.exit(1); }
    const r = await capture(s, { force: !!flag(args, '--force'), fresh: !!flag(args, '--fresh') });
    log(`capture ${tool}:${s.id} ${JSON.stringify(r)}`);
    console.log(JSON.stringify(r, null, 1));
  },

  // Hooks must return fast: hand the work to a detached child.
  hook(args) {
    if (process.env.AGENT_WIKI_RUNNING) return;
    const event = args[0];
    let input = {};
    try { input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch { /* no stdin */ }
    if (event === 'claude-session-end' && input.transcript_path) {
      const child = spawn(process.execPath, [SELF, 'capture', '--tool', 'claude', '--file', input.transcript_path],
        { detached: true, stdio: 'ignore' });
      child.unref();
    }
  },

  // Every few minutes: capture sessions idle past the limit with new work (covers sleep, Codex, crashes).
  async sweep(args) {
    const dry = !!flag(args, '--dry-run');
    const max = Number(flag(args, '--max') || 5);
    const r = await withLockAsync('sweep', async () => {
      const cfg = loadConfig();
      const since = Math.max(installedAt(), Date.now() - 7 * 86400_000);
      const idleMs = cfg.idle_minutes * 60_000;
      const st = loadState();
      const files = [...listClaudeFiles(since).map((f) => ['claude', f]), ...listCodexFiles(since).map((f) => ['codex', f]),
        ...listAgyFiles(since).map((f) => ['agy', f])];
      const due = [];
      for (const [tool, f] of files) {
        if (Date.now() - fileMtime(f) < idleMs) continue;
        const s = readSession(tool, f);
        if (!s.id || (s.headless && !cfg.include_headless)) continue;
        const last = lastEvent(s);
        if (!last) continue;
        const prev = st[`${tool}:${s.id}`];
        if (prev?.anchor === last.id) continue;
        const stuckMs = Date.now() - Date.parse(last.ts || 0);
        if (!s.finished && stuckMs < 3 * 3600_000) continue;
        if (userTurns(s) < cfg.min_turns) continue;
        due.push(s);
      }
      if (dry) return due.map((s) => `${s.tool}:${s.id} ${s.cwd}`);
      const lines = [];
      const vaults = new Set();
      for (const s of due.slice(0, max)) {
        const res = await capture(s);
        log(`sweep ${s.tool}:${s.id} ${JSON.stringify(res)}`);
        if (res.page) vaults.add(res.vault);
        lines.push(`${s.tool}:${s.id} ${JSON.stringify(res)}`);
      }
      for (const v of vaults) {
        const o = organizeSafe(v);
        lines.push(`organize ${v} ${JSON.stringify(o)}`);
        if (!o.error && o.changed) syncVault(vaultPath(cfg, v), `organize: ${o.changed} change(s)`);
      }
      return lines;
    }, { staleMs: 60 * 60_000 });
    console.log(r.locked ? 'sweep already running' : r.value.join('\n') || 'nothing due');
  },

  // Commit and push a vault (after a manual page write, e.g. a saved discussion).
  sync(args) {
    const cfg = loadConfig();
    const name = args[0] || resolveVault(cfg, process.cwd(), null);
    const dir = vaultPath(cfg, name);
    if (!dir) { console.error(`unknown vault "${name}"`); process.exit(1); }
    const r = syncVault(dir, `sync from ${cfg.machine}`);
    console.log(r.ok ? `synced ${name}` : `sync failed: ${r.error}`);
    if (!r.ok) process.exit(1);
  },

  // Wispr Flow meetings → vault pages (daily timer). `meetings import [--vault N] [--since ISO] [--dry-run] [--limit N]`
  meetings(args) {
    if (args.shift() !== 'import') { console.error('usage: agent-wiki meetings import [--vault <name>] [--since <ISO>] [--dry-run] [--limit N]'); process.exit(1); }
    const dry = !!flag(args, '--dry-run');
    const cfg = loadConfig();
    const name = flag(args, '--vault') || cfg.meetings_vault || 'work';
    const sinceFlag = flag(args, '--since');
    const limit = Number(flag(args, '--limit')) || undefined;
    const dir = vaultPath(cfg, name);
    if (!dir) { console.error(`unknown vault "${name}" — add it with: agent-wiki vault new ${name} <owner/repo>`); process.exit(1); }
    const r = withLock('meetings', () => {
      const started = new Date().toISOString();
      const since = typeof sinceFlag === 'string' ? new Date(sinceFlag).toISOString() : loadState().meetings?.last_run;
      if (!fs.existsSync(dir)) initVault(dir);
      const res = importMeetings(dir, { since, limit, dryRun: dry, model: cfg.fallback_model, log });
      if (res.error) {
        log(`meetings ${res.error}`);
        if (!dry) updateState('meetings', { failed_at: new Date().toISOString(), failed_reason: String(res.error).slice(0, 400) });
        return res;
      }
      if (!dry) {
        updateState('meetings', { failed_at: null, failed_reason: null });
        if (res.pages.length) res.organize = organizeSafe(name);
        res.sync = res.pages.length ? syncVault(dir, `meetings: ${res.pages.length} imported`) : { ok: true, note: 'nothing new' };
        // Overlap by a day: a late-edited meeting is re-read, and dedupe by wispr_id keeps one page.
        if (!limit && !sinceFlag && !res.errors.length) updateState('meetings', { last_run: new Date(Date.parse(started) - 86400_000).toISOString() });
      }
      log(`meetings ${JSON.stringify({ since, n: res.pages.length, cost: res.cost, errors: res.errors })}`);
      return res;
    }, { staleMs: 60 * 60_000 });
    if (r.locked) { console.log('meetings import already running'); return; }
    console.log(JSON.stringify(r.value, null, 1));
    if (r.value.error || r.value.sync?.ok === false) process.exit(1);
  },

  // Sort pages into projects. `organize [--vault <name>] [--all]` (--all = reconsider every page)
  organize(args) {
    const all = !!flag(args, '--all');
    const vname = flag(args, '--vault');
    const cfg = loadConfig();
    const names = typeof vname === 'string' ? [vname] : Object.keys(cfg.vaults);
    let bad = false;
    for (const n of names) {
      const r = organizeSafe(n, { all });
      console.log(`${n}: ${JSON.stringify(r)}`);
      if (r.error) { bad = true; continue; }
      if (r.changed) syncVault(vaultPath(cfg, n), `organize: ${r.changed} change(s)`);
    }
    if (bad) process.exit(1);
  },

  // Give old session pages a short title in the file name and fix every link to them.
  // `migrate-names [--vault <name>] [--dry-run]`
  'migrate-names'(args) {
    const dry = !!flag(args, '--dry-run');
    const vname = flag(args, '--vault');
    const cfg = loadConfig();
    const names = typeof vname === 'string' ? [vname] : Object.keys(cfg.vaults);
    let bad = false;
    for (const n of names) {
      const dir = vaultPath(cfg, n);
      if (!dir || !fs.existsSync(dir)) { console.error(`unknown vault "${n}"`); bad = true; continue; }
      const plan = planRenames(dir);
      console.log(`${n}: ${plan.length} session page(s) to rename${dry ? ' (dry run)' : ''}`);
      for (const { from, to } of plan) console.log(`  ${from} -> ${to}`);
      if (dry || !plan.length) continue;
      const before = brokenLinks(dir).length;
      const r = applyRenames(dir, plan);
      const st = loadState();
      renameInState(st, plan);
      saveState(st);
      const after = brokenLinks(dir).length;
      console.log(`${n}: renamed ${r.renamed}, rewrote ${r.links} link(s) in ${r.files} file(s); broken links before ${before}, after ${after}`);
      if (after > before) { console.error(`${n}: renaming left ${after - before} new broken link(s)`); bad = true; }
      const sync = syncVault(dir, `rename ${r.renamed} session page(s) to short names`);
      if (!sync.ok) { console.error(`${n}: sync failed: ${sync.error}`); bad = true; }
    }
    if (bad) process.exit(1);
  },

  // Wire this machine: personal vault, skills, Claude hook, sweep timer, global read-instruction.
  install(args) {
    const dry = !!flag(args, '--dry-run');
    const root = path.dirname(path.dirname(SELF));
    const home = process.env.HOME;
    const steps = [];
    const act = (what, fn) => { steps.push(what); if (!dry) fn(); };
    const cfg = loadConfig();

    if (!cfg.vaults.personal) {
      act('create local vault "personal" at ~/wikis/personal (add a GitHub remote later)', () => {
        const dir = path.join(home, 'wikis', 'personal');
        initVault(dir);
        if (!fs.existsSync(path.join(dir, '.git'))) spawnSync('git', ['-C', dir, 'init', '-q']);
        cfg.vaults.personal = { path: '~/wikis/personal' };
        saveConfig(cfg);
      });
    }
    installedAt();

    // Skills: one copy, linked into every agent's skill folder that exists.
    for (const base of ['.claude/skills', '.codex/skills', '.agents/skills', '.gemini/skills']) {
      const dir = path.join(home, base);
      if (!fs.existsSync(dir)) continue;
      for (const sk of ['wiki', 'set-wiki']) {
        const link = path.join(dir, sk);
        if (fs.existsSync(link)) continue;
        act(`link skill ${sk} → ~/${base}/${sk}`, () => fs.symlinkSync(path.join(root, 'skill', sk), link));
      }
    }

    // CLI on PATH.
    const bin = path.join(home, '.local', 'bin', 'agent-wiki');
    if (!fs.existsSync(bin)) act('link ~/.local/bin/agent-wiki', () => { fs.mkdirSync(path.dirname(bin), { recursive: true }); fs.symlinkSync(SELF, bin); });

    // Claude Code hooks: SessionEnd (capture) and UserPromptSubmit (point the agent at related past pages).
    const settings = path.join(home, '.claude', 'settings.json');
    if (fs.existsSync(settings)) {
      const s = JSON.parse(fs.readFileSync(settings, 'utf8'));
      const wanted = [
        ['SessionEnd', `node "${SELF}" hook claude-session-end`, 10, 'Claude SessionEnd hook'],
        ['UserPromptSubmit', `node "${SELF}" hook claude-prompt`, 5, 'Claude UserPromptSubmit hook (related past work)'],
      ];
      for (const [event, cmd, timeout, label] of wanted) {
        if (JSON.stringify(s.hooks?.[event] || []).includes('agent-wiki')) continue;
        act(`add ${label} (backup: settings.json.bak-agent-wiki)`, () => {
          if (!fs.existsSync(settings + '.bak-agent-wiki')) fs.copyFileSync(settings, settings + '.bak-agent-wiki');
          s.hooks = s.hooks || {};
          s.hooks[event] = [...(s.hooks[event] || []), { hooks: [{ type: 'command', command: cmd, timeout }] }];
          fs.writeFileSync(settings, JSON.stringify(s, null, 2) + '\n');
        });
      }
    }

    // Codex UserPromptSubmit hook: same JSON in and out as Claude's. Codex asks you to trust a new hook once (/hooks).
    const codexHooks = path.join(home, '.codex', 'hooks.json');
    if (fs.existsSync(codexHooks)) {
      const h = JSON.parse(fs.readFileSync(codexHooks, 'utf8'));
      if (!JSON.stringify(h.hooks?.UserPromptSubmit || []).includes('agent-wiki')) {
        act('add Codex UserPromptSubmit hook (backup: hooks.json.bak-agent-wiki; Codex asks you to trust it once)', () => {
          if (!fs.existsSync(codexHooks + '.bak-agent-wiki')) fs.copyFileSync(codexHooks, codexHooks + '.bak-agent-wiki');
          h.hooks = h.hooks || {};
          h.hooks.UserPromptSubmit = [...(h.hooks.UserPromptSubmit || []), { hooks: [{ type: 'command', command: `node "${SELF}" hook codex-prompt`, timeout: 5 }] }];
          fs.writeFileSync(codexHooks, JSON.stringify(h, null, 2) + '\n');
        });
      }
    }

    // Global "read the wiki" instruction for Claude and Codex.
    const line = '\n## Agent wiki\nPast work, decisions and meetings live in the agent wiki. Before a task, read the `index.md` of the relevant vault (`agent-wiki vault list` shows paths) and open matching pages. Use the `wiki` skill to save or continue discussions; `/set-wiki` picks the vault.\n';
    for (const f of ['.claude/CLAUDE.md', '.codex/AGENTS.md']) {
      const p = path.join(home, f);
      if (!fs.existsSync(path.dirname(p))) continue;
      if (fs.existsSync(p) && fs.readFileSync(p, 'utf8').includes('## Agent wiki')) continue;
      act(`add wiki note to ~/${f}`, () => fs.appendFileSync(p, line));
    }

    // Sweep every 5 minutes (systemd user timer).
    const unitDir = path.join(home, '.config', 'systemd', 'user');
    if (!fs.existsSync(path.join(unitDir, 'agent-wiki-sweep.timer'))) {
      act('install systemd user timer agent-wiki-sweep (every 5 min)', () => {
        fs.mkdirSync(unitDir, { recursive: true });
        fs.writeFileSync(path.join(unitDir, 'agent-wiki-sweep.service'),
          `[Unit]\nDescription=agent-wiki sweep\n\n[Service]\nType=oneshot\nEnvironment=PATH=${process.env.PATH}\nExecStart=${process.execPath} ${SELF} sweep\nNice=10\n`);
        fs.writeFileSync(path.join(unitDir, 'agent-wiki-sweep.timer'),
          '[Unit]\nDescription=agent-wiki sweep every 5 min\n\n[Timer]\nOnBootSec=3min\nOnUnitActiveSec=5min\nPersistent=true\n\n[Install]\nWantedBy=timers.target\n');
        spawnSync('systemctl', ['--user', 'daemon-reload']);
        spawnSync('systemctl', ['--user', 'enable', '--now', 'agent-wiki-sweep.timer']);
      });
    }
    // Meetings import daily at 08:00 local.
    if (!fs.existsSync(path.join(unitDir, 'agent-wiki-meetings.timer'))) {
      act('install systemd user timer agent-wiki-meetings (daily 08:00)', () => {
        fs.mkdirSync(unitDir, { recursive: true });
        fs.writeFileSync(path.join(unitDir, 'agent-wiki-meetings.service'),
          `[Unit]\nDescription=agent-wiki Wispr meetings import\n\n[Service]\nType=oneshot\nEnvironment=PATH=${process.env.PATH}\nExecStart=${process.execPath} ${SELF} meetings import\nNice=10\n`);
        fs.writeFileSync(path.join(unitDir, 'agent-wiki-meetings.timer'),
          '[Unit]\nDescription=agent-wiki meetings import daily\n\n[Timer]\nOnCalendar=*-*-* 08:00:00\nPersistent=true\n\n[Install]\nWantedBy=timers.target\n');
        spawnSync('systemctl', ['--user', 'daemon-reload']);
        spawnSync('systemctl', ['--user', 'enable', '--now', 'agent-wiki-meetings.timer']);
      });
    }
    console.log((dry ? 'would:\n' : 'done:\n') + (steps.map((x) => `- ${x}`).join('\n') || '- nothing to do'));
  },

  status() {
    const cfg = loadConfig();
    console.log(`machine: ${cfg.machine}\ndefault vault: ${cfg.default}`);
    for (const [n] of Object.entries(cfg.vaults)) {
      const dir = vaultPath(cfg, n);
      const ahead = spawnSync('git', ['-C', dir, 'rev-list', '--count', '@{u}..HEAD'], { encoding: 'utf8' });
      console.log(`vault ${n}: ${dir} ${ahead.status === 0 ? `(${ahead.stdout.trim()} commits not pushed)` : ''}`);
    }
    const st = loadState();
    const m = st.meetings;
    if (m?.failed_at) console.log(`meetings: last import failed ${m.failed_at}: ${m.failed_reason}`);
    else if (m?.last_run) console.log(`meetings: last import ok (read from ${m.last_run})`);
    const errors = Object.entries(st).filter(([, v]) => v.error);
    for (const [k, v] of errors) console.log(`error ${k}: ${v.error}`);
  },
};

const [cmd, ...args] = process.argv.slice(2);
if (!cmds[cmd]) {
  console.log('usage: agent-wiki <set|vault|image|drive|meetings|organize|migrate-names|import-claude-mem|capture|hook|sweep|sync|status> …');
  process.exit(cmd ? 1 : 0);
}
await cmds[cmd](args);
