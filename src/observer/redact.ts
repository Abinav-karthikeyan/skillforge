/**
 * Redaction at capture, before anything is persisted (plan_v3 §3.4). Every
 * string in a hook payload passes through `redactText`; values under secret-ish
 * keys and the contents of `.env` files are dropped wholesale. The pattern list
 * is exercised by a corpus test (tests/observer/redact.test.ts): zero secrets
 * may survive it.
 *
 * Bias: false positives (an over-redacted hash) are cheap; a leaked key is not.
 */
export const REDACTED = "[REDACTED]";

const PATTERNS: Array<[name: string, re: RegExp]> = [
  ["private-key", /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g],
  ["anthropic-key", /\bsk-ant-[A-Za-z0-9_-]{16,}/g],
  ["openai-key", /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g],
  ["github-token", /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{22,})/g],
  ["gitlab-token", /\bglpat-[A-Za-z0-9_-]{20,}/g],
  ["npm-token", /\bnpm_[A-Za-z0-9]{36}\b/g],
  ["aws-access-key", /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA|ANVA|AIPA)[0-9A-Z]{16}\b/g],
  ["google-api-key", /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ["slack-token", /\bxox[abposr]-[A-Za-z0-9-]{10,}/g],
  ["slack-webhook", /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]+/g],
  ["stripe-key", /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}/g],
  ["notion-token", /\b(?:ntn_|secret_)[A-Za-z0-9]{40,}/g],
  ["huggingface-token", /\bhf_[A-Za-z0-9]{30,}/g],
  ["jwt", /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g],
  ["azure-account-key", /\b(AccountKey|SharedAccessKey)=[A-Za-z0-9+/=]{20,}/g],
  ["bearer", /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/g],
];

// scheme://user:password@host — keep the shape, drop the password.
const CONNECTION_STRING = /\b([a-z][a-z0-9+.-]{1,20}:\/\/[^\s:@/]+):([^\s@/]+)@/gi;

// KEY=value / "key": "value" assignments for secret-sounding names.
const SECRET_ASSIGNMENT =
  /\b([A-Za-z0-9_.-]*(?:password|passwd|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|client[_-]?secret|credentials?)[A-Za-z0-9_.-]*)(["']?\s*[:=]\s*["']?)([^\s"',;]{6,})/gi;

const SECRET_KEY_NAME = /(password|passwd|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|client[_-]?secret|credential|authorization|cookie)/i;

/** Redact secrets inside free text. */
export function redactText(text: string): string {
  let out = text;
  for (const [, re] of PATTERNS) out = out.replace(re, REDACTED);
  out = out.replace(CONNECTION_STRING, `$1:${REDACTED}@`);
  out = out.replace(SECRET_ASSIGNMENT, (m, key: string, sep: string, value: string) =>
    value === REDACTED || /^\[REDACTED/.test(value) ? m : `${key}${sep}${REDACTED}`
  );
  return out;
}

/** True for paths whose contents must never be journaled. */
export function isSecretFile(path: string): boolean {
  const base = path.replace(/\\/g, "/").split("/").pop() ?? path;
  return (
    /^\.env(\..+)?$/i.test(base) && !/\.(example|sample|template)$/i.test(base)
  ) || /\.(pem|key|p12|pfx|jks|keystore)$/i.test(base) || /^(id_rsa|id_ed25519|id_ecdsa)(\.pub)?$/.test(base) ||
    /^\.?(npmrc|pypirc|netrc|git-credentials)$/i.test(base) || /^credentials(\.json)?$/i.test(base);
}

/** Does a shell command read a secret file (`cat .env`, `source .env`, …)? */
export function commandTouchesSecretFile(command: string): boolean {
  return command
    .split(/[\s;&|<>()'"]+/)
    .some((tok) => tok.length > 0 && !tok.startsWith("-") && isSecretFile(tok));
}

/**
 * Deep-redact a JSON value. Strings are scanned; values under secret-named
 * keys are replaced outright; strings are capped at `maxString` chars (head
 * and tail kept) so a giant tool response can't bloat the journal.
 */
export function redactValue(value: unknown, maxString = 4_000, depth = 0): unknown {
  if (depth > 12) return "[depth limit]";
  if (typeof value === "string") return capString(redactText(value), maxString);
  if (Array.isArray(value)) return value.slice(0, 200).map((v) => redactValue(v, maxString, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEY_NAME.test(k) && (typeof v === "string" || typeof v === "number")
        ? REDACTED
        : redactValue(v, maxString, depth + 1);
    }
    return out;
  }
  return value;
}

export function capString(s: string, max: number): string {
  if (s.length <= max) return s;
  const head = Math.floor(max * 0.7);
  const tail = max - head;
  return `${s.slice(0, head)}\n… [${s.length - max} chars elided] …\n${s.slice(s.length - tail)}`;
}
