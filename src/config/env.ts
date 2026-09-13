import { config as dotenvConfig } from "dotenv";
import { existsSync } from "fs";
import { join } from "path";
import { envPath } from "./paths.js";

/**
 * Load environment variables from .env files. Called once at process start
 * (imported for side-effects from CLI and MCP entry points).
 *
 * Lookup order (first hit wins for a given key; existing process.env always wins):
 *   1. Shell environment (already set — never overridden)
 *   2. <cwd>/.env               — project-local secrets
 *   3. ~/.career-mode/.env      — user-global fallback for globally-installed CLI
 *
 * `override: false` on every load so shell env beats file env, and the earlier
 * file wins over the later file. This matches the convention every other CLI uses.
 */
export function loadDotenvFiles(): void {
  const candidates = [
    join(process.cwd(), ".env"),
    envPath(),
  ];

  for (const path of candidates) {
    if (existsSync(path)) {
      dotenvConfig({ path, override: false, quiet: true });
    }
  }
}
