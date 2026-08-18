import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { parse } from "yaml";
import {
  CalibrationConfig,
  DEFAULT_CALIBRATION,
} from "../types/config.js";

const SECRET_FIELDS = ["api_key", "gist_token", "notion_token", "notion_database_id"];

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
        const parsed = parse(raw) as Record<string, any>;
        for (const field of SECRET_FIELDS) {
          if (parsed[field]) parsed[field] = resolveEnvRef(parsed[field], field);
        }
        return { ...DEFAULT_CALIBRATION, ...parsed };
      } catch (err) {
        if (err instanceof Error && err.message.includes("references env var")) throw err;
      }
    }
  }

  return DEFAULT_CALIBRATION;
}
