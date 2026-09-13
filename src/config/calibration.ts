import { readFileSync, existsSync } from "fs";
import { parse } from "yaml";
import {
  CalibrationConfig,
  DEFAULT_CALIBRATION,
} from "../types/config.js";
import { projectConfigPath, configYamlPath } from "./paths.js";

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
    projectConfigPath(),
    configYamlPath(),
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
        // Malformed YAML (or similar) should not silently vanish — warn to
        // stderr (safe for the MCP stdio channel) and fall through to the next
        // candidate / built-in defaults, so a typo is visible rather than
        // mysteriously ignored.
        console.warn(
          `skill-forge: could not parse config at ${p}: ${(err as Error).message}. Falling back to defaults.`
        );
      }
    }
  }

  return DEFAULT_CALIBRATION;
}
