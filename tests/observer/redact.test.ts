import { describe, expect, it } from "vitest";
import { commandTouchesSecretFile, isSecretFile, REDACTED, redactText, redactValue } from "../../src/observer/redact.js";
import { normalizeClaudeCode } from "../../src/observer/normalize.js";

/**
 * Redaction corpus (plan_v3 §3.7 exit criterion: zero secrets survive).
 * Secrets are assembled at runtime from fragments so this file never
 * contains a literal token that secret scanners would flag.
 */
const r = (n: number, alphabet = "aB3dE5fG7hJ9kL2mN4pQ6rS8tU0vW1xY") =>
  Array.from({ length: n }, (_, i) => alphabet[(i * 7 + 3) % alphabet.length]).join("");
const UP = (n: number) => r(n, "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567");

const SECRETS: Array<[label: string, secret: string, context: (s: string) => string]> = [
  ["anthropic", "sk-" + "ant-api03-" + r(40), (s) => `export ANTHROPIC_API_KEY=${s}`],
  ["openai project", "sk-" + "proj-" + r(48), (s) => `OPENAI_API_KEY="${s}"`],
  ["openai legacy", "sk-" + r(48), (s) => `client = OpenAI(api_key="${s}")`],
  ["github classic", "gh" + "p_" + r(36), (s) => `git clone https://${s}@github.com/org/repo`],
  ["github fine-grained", "github_" + "pat_" + r(22) + "_" + r(59), (s) => `token: ${s}`],
  ["gitlab", "glp" + "at-" + r(20), (s) => `GITLAB_TOKEN=${s}`],
  ["npm", "np" + "m_" + r(36), (s) => `//registry.npmjs.org/:_authToken=${s}`],
  ["aws access key", "AK" + "IA" + UP(16), (s) => `aws_access_key_id = ${s}`],
  ["aws secret", r(40, "abcdefghijklmnopqrstuvwxyzABCDEFGHIJ0123456789/+"), (s) => `aws_secret_access_key = ${s}`],
  ["google api", "AI" + "za" + r(35), (s) => `const key = "${s}"`],
  ["slack bot", "xo" + "xb-" + r(12, "0123456789") + "-" + r(24), (s) => `SLACK_BOT_TOKEN=${s}`],
  ["slack webhook", "https://hooks.slack.com/services/" + UP(9) + "/" + UP(11) + "/" + r(24), (s) => `curl -X POST ${s}`],
  ["stripe", "sk" + "_live_" + r(24), (s) => `stripe.api_key = '${s}'`],
  ["notion", "nt" + "n_" + r(46), (s) => `NOTION_TOKEN=${s}`],
  ["huggingface", "h" + "f_" + r(34), (s) => `HF_TOKEN=${s}`],
  ["jwt", "ey" + "JhbGciOiJIUzI1NiJ9" + "." + "ey" + "JzdWIiOiIxMjM0NTY3ODkwIn0" + "." + r(43), (s) => `Authorization: ${s}`],
  ["bearer", r(32), (s) => `curl -H "Authorization: Bearer ${s}" https://api.example.com`],
  ["postgres password", "s3cr3t-" + r(12), (s) => `DATABASE_URL=postgres://app:${s}@db.internal:5432/app`],
  ["mongodb password", "Pa55" + r(10), (s) => `mongodb+srv://admin:${s}@cluster0.example.net/test`],
  ["azure storage", r(86, "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+/") + "==", (s) => `DefaultEndpointsProtocol=https;AccountName=x;AccountKey=${s};EndpointSuffix=core.windows.net`],
  ["generic password", "hunter2-" + r(10), (s) => `password: "${s}"`],
  ["generic client secret", r(30), (s) => `CLIENT_SECRET=${s}`],
  ["private key", "MIIEvQIBADANBgkqhkiG9w0BAQEFAASC" + r(64), (s) => `-----BEGIN PRIVATE KEY-----\n${s}\n-----END PRIVATE KEY-----`],
  ["rsa private key", "MIIEpAIBAAKCAQEA" + r(64), (s) => `-----BEGIN RSA PRIVATE KEY-----\n${s}\n${r(64)}\n-----END RSA PRIVATE KEY-----`],
];

describe("redaction corpus", () => {
  for (const [label, secret, context] of SECRETS) {
    it(`removes ${label}`, () => {
      const out = redactText(`before ${context(secret)} after`);
      expect(out).not.toContain(secret);
      expect(out).toContain(REDACTED);
      expect(out.startsWith("before ")).toBe(true);
    });
  }

  it("redacts secrets nested anywhere in a hook payload, and secret-named keys outright", () => {
    const payload = {
      tool_input: { command: `curl -H "x-api-key: ${SECRETS[0][1]}" https://api.anthropic.com` },
      tool_response: { stdout: `found ${SECRETS[3][1]} in history`, nested: [{ deep: SECRETS[12][1] }] },
      env: { DB_PASSWORD: "short1", apiKey: "abc" },
    };
    const json = JSON.stringify(redactValue(payload));
    for (const [, secret] of [SECRETS[0], SECRETS[3], SECRETS[12]]) expect(json).not.toContain(secret);
    expect(json).not.toContain("short1");
  });

  it("leaves ordinary engineering text alone", () => {
    const text = "Refactored the token bucket: refill rate 10/s, capacity 20. Commit 3f2a9c1. See src/limiter/token-bucket.ts:42.";
    expect(redactText(text)).toBe(text);
  });

  it("never journals .env contents or commands that read secret files", () => {
    expect(isSecretFile(".env")).toBe(true);
    expect(isSecretFile("config/.env.production")).toBe(true);
    expect(isSecretFile(".env.example")).toBe(false);
    expect(isSecretFile("id_rsa")).toBe(true);
    expect(commandTouchesSecretFile("cat .env")).toBe(true);
    expect(commandTouchesSecretFile("source ./.env && npm start")).toBe(true);
    expect(commandTouchesSecretFile("cat README.md")).toBe(false);

    const [event] = normalizeClaudeCode({
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: "cat .env" },
      tool_response: { stdout: "INTERNAL_FLAG=on\nSOMETHING=else" },
    });
    expect(JSON.stringify(event)).not.toContain("INTERNAL_FLAG");
    expect(event.payload.output).toBe(REDACTED);
  });

  it("journals file paths but never file contents", () => {
    const [event] = normalizeClaudeCode({
      hook_event_name: "PostToolUse",
      tool_name: "Write",
      tool_input: { file_path: "src/a.ts", content: `const k = "${SECRETS[1][1]}";` },
      tool_response: { filePath: "src/a.ts", type: "create" },
    });
    expect(event).toEqual({ kind: "file_edit", agent_id: undefined, payload: { tool: "Write", path: "src/a.ts", op: "create", manifest: undefined, secret_file: undefined } });
  });

  it("caps huge tool output", () => {
    const [event] = normalizeClaudeCode({
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: "cat big.log" },
      tool_response: { stdout: "x".repeat(100_000) },
    });
    expect(String(event.payload.output).length).toBeLessThan(1_700);
  });
});
