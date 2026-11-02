// Import this FIRST in a test file: it points agent-wiki at a scratch home before any lib loads.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-wiki-test-'));
process.env.AGENT_WIKI_HOME = path.join(SCRATCH, 'wiki-home');
fs.mkdirSync(process.env.AGENT_WIKI_HOME, { recursive: true });

export const mk = (...parts) => { const p = path.join(SCRATCH, ...parts); fs.mkdirSync(path.dirname(p), { recursive: true }); return p; };
export const write = (rel, text) => { const p = mk(rel); fs.writeFileSync(p, text); return p; };
export const jsonl = (rel, rows) => write(rel, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
