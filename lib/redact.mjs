// Remove secrets from text before it is written to a vault.
// Patterns follow AlexanderMakarov/llm-wiki convert.py, plus Google/Supabase/TOTP-ish extras.
const PATTERNS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED PRIVATE KEY]'],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}\b/g, '[REDACTED GITHUB TOKEN]'],
  [/\bgithub_pat_[A-Za-z0-9_]{40,}\b/g, '[REDACTED GITHUB TOKEN]'],
  [/\bsk-ant-[A-Za-z0-9_-]{20,}\b/g, '[REDACTED ANTHROPIC KEY]'],
  [/\bsk-(proj-)?[A-Za-z0-9_-]{32,}\b/g, '[REDACTED OPENAI KEY]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED AWS KEY]'],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, '[REDACTED GOOGLE KEY]'],
  [/\bya29\.[0-9A-Za-z_-]{20,}\b/g, '[REDACTED GOOGLE TOKEN]'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, '[REDACTED SLACK TOKEN]'],
  [/\b[rs]k_live_[A-Za-z0-9]{20,}\b/g, '[REDACTED STRIPE KEY]'],
  [/\bnpm_[A-Za-z0-9]{36}\b/g, '[REDACTED NPM TOKEN]'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[REDACTED JWT]'],
  [/"private_key"\s*:\s*"[^"]+"/g, '"private_key": "[REDACTED]"'],
  [/\b(password|passwd|secret|api[_-]?key|token)\s*[:=]\s*["']?[^\s"']{8,}/gi, '$1=[REDACTED]'],
];

export function redact(text) {
  let out = text;
  for (const [re, rep] of PATTERNS) out = out.replace(re, rep);
  return out;
}
