#!/usr/bin/env node
/**
 * Plugin hook shim for the skill-forge observer.
 *
 * The plugin's hooks run this file (exec form, via ${CLAUDE_PLUGIN_ROOT}) instead
 * of calling `skill-forge-observe` from PATH, so a user who installed the plugin
 * but not the npm package sees nothing at all — no "command not found" on every
 * session start. When the package is installed globally, the capture bin is
 * imported in-process (no second Node startup); otherwise this exits 0.
 *
 * Dependency-free on purpose: it runs before anything else is known to exist.
 */
import { existsSync, readdirSync, realpathSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const PKG = join("@abhinavravich1999", "skill-forge");
const BIN = join("dist", "observer", "observe-bin.js");

function findCaptureBin() {
  const candidates = [];
  for (const dir of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    let names;
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    if (!names.some((n) => n === "skill-forge-observe" || n.startsWith("skill-forge-observe."))) continue;
    // POSIX: the bin is a symlink to the package's JS file.
    try {
      const real = realpathSync(join(dir, "skill-forge-observe"));
      if (real.endsWith(".js")) candidates.push(real);
    } catch {
      /* Windows .cmd shims are not symlinks */
    }
    // Windows layout: <prefix>/skill-forge-observe.cmd + <prefix>/node_modules/<pkg>
    candidates.push(join(dir, "node_modules", PKG, BIN));
    // POSIX layout: <prefix>/bin + <prefix>/lib/node_modules/<pkg>
    candidates.push(join(dirname(dir), "lib", "node_modules", PKG, BIN));
  }
  return candidates.find((c) => existsSync(c)) ?? null;
}

const bin = findCaptureBin();
if (bin) {
  // observe-bin reads process.argv.slice(2) ("--host claude-code") and stdin itself.
  await import(pathToFileURL(bin).href);
} else {
  process.stdin.resume();
  process.stdin.on("end", () => process.exit(0));
  setTimeout(() => process.exit(0), 200).unref();
}
