import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { parse } from "yaml";
import {
  CalibrationConfig,
  DEFAULT_CALIBRATION,
} from "../types/config.js";

/**
 * Resolves `${VAR}` in a string against process.env. Only matches when the
 * ENTIRE value is a single `${VAR}` reference — mixed strings like
 * "prefix-${VAR}-suffix" are left as-is by design (secrets shouldn't be
 * spliced into partial strings; if you need that, put the whole thing in env).
 * Throws with a clear error when the referenced env var is unset — silent
 * fallback would produce a literal "${DEEPSEEK_API_KEY}" that 401s at call time.
 */
function resolveEnvRef(value: string, fieldName: string): string {
  const match = /^\$\{(\w+)\}$/.exec(value);
  if (!match) return value;
  const envName = match[1];
  const resolved = process.env[envName];
  if (resolved === undefined || resolved === "") {
    throw new Error(
      `${fieldName} references env var $${envName} but it is not set. ` +
        `Add ${envName}=... to your .env (project root or ~/.career-mode/.env) or export it in your shell.`
    );
  }
  return resolved;
}

export function loadCalibration(): CalibrationConfig {
  const candidates = [
    join(process.cwd(), "career-mode.config.yaml"),
    join(homedir(), ".career-mode", "config.yaml"),
  ];

  for (const p of candidates) {
    if (existsSync(p)) {
      try {
        const raw = readFileSync(p, "utf-8");
        const parsed = parse(raw) as Partial<CalibrationConfig>;
        // Fields that commonly hold secrets — support ${VAR} indirection.
        if (parsed.api_key) parsed.api_key = resolveEnvRef(parsed.api_key, "api_key");
        if (parsed.gist_token) parsed.gist_token = resolveEnvRef(parsed.gist_token, "gist_token");
        return { ...DEFAULT_CALIBRATION, ...parsed };
      } catch (err) {
        // If the failure is our env-ref error, surface it — don't silently fall back.
        if (err instanceof Error && err.message.includes("references env var")) throw err;
        // Otherwise (yaml parse issue, io error), fall through to the next candidate.
      }
    }
  }

  return DEFAULT_CALIBRATION;
}
