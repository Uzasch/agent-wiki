// Helpers for tests that need git remotes and fake `claude` / `systemctl` commands. Import after ./setup.mjs.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { SCRATCH } from './setup.mjs';

// Same git identity everywhere, and no user git config (signing, hooks, pull.rebase) leaking into the tests.
Object.assign(process.env, {
  GIT_AUTHOR_NAME: 'tester', GIT_AUTHOR_EMAIL: 'tester@example.com', GIT_COMMITTER_NAME: 'tester', GIT_COMMITTER_EMAIL: 'tester@example.com',
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
});

export const sh = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed: ${r.stdout}${r.stderr}`);
  return r.stdout.trim();
};

let n = 0;
// A bare "remote" plus a function that makes clones of it (each clone = one machine's copy of the vault).
export function makeRemote() {
  const root = path.join(SCRATCH, `remote-${n++}`);
  const bare = path.join(root, 'remote.git');
  fs.mkdirSync(bare, { recursive: true });
  sh('git', ['init', '-q', '--bare', '-b', 'main', bare]);
  let first = true;
  const clone = (name) => {
    const dir = path.join(root, name);
    sh('git', ['clone', '-q', bare, dir], { stdio: 'pipe' });
    sh('git', ['-C', dir, 'checkout', '-q', '-B', 'main']);
    if (first) {   // the first clone makes the first commit, so later clones have a branch to follow
      fs.writeFileSync(path.join(dir, 'README.md'), '# vault\n');
      sh('git', ['-C', dir, 'add', '-A']);
      sh('git', ['-C', dir, 'commit', '-q', '-m', 'init']);
      sh('git', ['-C', dir, 'push', '-q', '-u', 'origin', 'main']);
      first = false;
    }
    return dir;
  };
  return { bare, clone };
}

// A directory with fake commands first on PATH. `files` = { name: script text }.
export function fakeBin(files) {
  const bin = path.join(SCRATCH, `fakebin-${n++}`);
  fs.mkdirSync(bin, { recursive: true });
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(bin, name), text, { mode: 0o755 });
  return bin;
}

// Fake `claude`: `mcp list` prints $FAKE_MCP_LIST; `-p` answers like the model would. Every call is appended to $FAKE_CLAUDE_LOG.
export const FAKE_CLAUDE = `#!/usr/bin/env node
const fs = require('node:fs');
const a = process.argv.slice(2);
if (process.env.FAKE_CLAUDE_LOG) fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify(a) + '\\n');
if (a[0] === 'mcp' && a[1] === 'list') { process.stdout.write('Checking MCP server health…\\n\\n' + (process.env.FAKE_MCP_LIST || '')); process.exit(0); }
if (a[0] === '-p') {
  const prompt = a[1];
  const meetings = JSON.parse(process.env.FAKE_MEETINGS || '[]');
  let result = '[]';
  if (/search_meetings/.test(prompt)) result = JSON.stringify(meetings.map(({ id, title, start }) => ({ id, title, start })));
  else if (/get_meeting/.test(prompt)) result = JSON.stringify(meetings.find((m) => prompt.includes('id ' + m.id + '.')) || {});
  process.stdout.write(JSON.stringify({ result, total_cost_usd: 0.01 }));
  process.exit(0);
}
process.exit(0);
`;

export const FAKE_SYSTEMCTL = `#!/bin/sh
echo "$@" >> "$FAKE_SYSTEMCTL_LOG"
`;

// Lines as `claude mcp list` prints them.
export const MCP = {
  connector: 'claude.ai Wispr Flow: https://api.wisprflow.ai/connect/mcp - ✔ Connected',
  connectorNeedsAuth: 'claude.ai Wispr Flow: https://api.wisprflow.ai/connect/mcp - ! Needs authentication',
  direct: 'wispr: https://api.wisprflow.ai/connect/mcp (HTTP) - ✔ Connected',
  directNeedsAuth: 'wispr: https://api.wisprflow.ai/connect/mcp (HTTP) - ! Needs authentication',
  other: 'claude.ai Slack: https://mcp.slack.com/mcp - ! Needs authentication\nserena: uvx --from serena-agent serena start-mcp-server --context claude-code - ✔ Connected',
};
