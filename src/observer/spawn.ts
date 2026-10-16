import { spawn } from "child_process";
import { existsSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

/**
 * Launch a fully detached skill-forge worker (`skill-forge observe-worker …`)
 * and return immediately. Hooks use this so an LLM call never runs inside the
 * host's hook budget — SessionEnd only has ~1.5 s, enough to spawn but not to
 * think (plan_v3 §3.3).
 */
export function spawnDetachedWorker(args: string[]): boolean {
  const here = dirname(fileURLToPath(import.meta.url));
  const built = join(here, "..", "index.js");
  const source = join(here, "..", "index.ts");
  let entry: string[];
  if (existsSync(built)) entry = [built];
  else if (existsSync(source)) entry = [...process.execArgv, source]; // dev: keep the tsx loader flags
  else return false;
  try {
    const child = spawn(process.execPath, [...entry, "observe-worker", ...args], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: process.env,
    });
    child.on("error", () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}
