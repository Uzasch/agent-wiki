// The UserPromptSubmit hook (Claude Code and Codex use the same JSON). Kept apart from the CLI and free of
// the TOML library so it starts fast: it runs on every prompt.
import fs from 'node:fs';
import path from 'node:path';
import { quickConfig, quickVault, quickVaultPath, STATE_DIR } from './quickconfig.mjs';
import { search, worthSearching, contextText } from './promptsearch.mjs';

const logError = (msg) => {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.appendFileSync(path.join(STATE_DIR, 'agent-wiki.log'), `${new Date().toISOString()} ${msg}\n`);
  } catch { /* logging must never break the hook */ }
};

// The vault for a folder: the quick reader, or the full one when the config has something unusual.
async function vaultFor(cwd) {
  const q = quickConfig();
  if (q) { const name = quickVault(q, cwd); return { name, dir: name === 'off' ? null : quickVaultPath(q, name) }; }
  const c = await import('./config.mjs');
  const cfg = c.loadConfig();
  const name = c.resolveVault(cfg, cwd, null);
  return { name, dir: name === 'off' ? null : c.vaultPath(cfg, name) };
}

// Reads the hook JSON on stdin, prints additionalContext JSON when a past page matches, else nothing.
export async function promptHook(readStdin = () => fs.readFileSync(0, 'utf8')) {
  if (process.env.AGENT_WIKI_RUNNING) return;   // our own summariser runs: no context for those
  let input = {};
  try { input = JSON.parse(readStdin() || '{}'); } catch { return; }
  if (!worthSearching(input.prompt)) return;
  try {
    const { name, dir } = await vaultFor(input.cwd || process.cwd());
    if (!dir || !fs.existsSync(dir)) return;
    const hits = search(dir, input.prompt, { sessionId: input.session_id, cache: { path: path.join(STATE_DIR, 'prompt-pages.json') } });
    if (hits.length) {
      process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: contextText(name, dir, hits) } }));
    }
  } catch (e) { logError(`prompt hook failed: ${String(e.message || e).slice(0, 200)}`); }
}
