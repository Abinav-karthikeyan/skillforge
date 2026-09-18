import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// Mutable fake home, swapped per test. vi.hoisted so the mock factory can see it.
const state = vi.hoisted(() => ({ home: "" }));
vi.mock("os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("os")>();
  return { ...actual, homedir: () => state.home };
});

// Imported after the mock is registered (vi.mock is hoisted above imports).
import { configDir, resolveArtifactsDir, projectConfigPath, CONFIG_FILENAME } from "../../src/config/paths.js";

describe("config-dir naming fallback (P0.1 Increment B)", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "sf-home-"));
    state.home = home;
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it("uses ~/.skill-forge for a fresh install (neither dir exists)", () => {
    expect(configDir()).toBe(join(home, ".skill-forge"));
  });

  it("prefers ~/.skill-forge when both dirs exist", () => {
    mkdirSync(join(home, ".skill-forge"));
    mkdirSync(join(home, ".career-mode"));
    expect(configDir()).toBe(join(home, ".skill-forge"));
  });

  it("falls back to legacy ~/.career-mode when only it exists (no orphaning)", () => {
    mkdirSync(join(home, ".career-mode"));
    expect(configDir()).toBe(join(home, ".career-mode"));
    // Artifacts follow the resolved config dir, so an existing corpus keeps working.
    expect(resolveArtifactsDir()).toBe(join(home, ".career-mode", "artifacts"));
  });

  it("resolveArtifactsDir honors an explicit preference over the default", () => {
    expect(resolveArtifactsDir("/tmp/custom")).toBe("/tmp/custom");
  });
});

describe("project config filename fallback", () => {
  let dir: string;
  let prevCwd: string;
  beforeEach(() => {
    prevCwd = process.cwd();
    dir = mkdtempSync(join(tmpdir(), "sf-proj-"));
  });
  afterEach(() => {
    process.chdir(prevCwd);
    rmSync(dir, { recursive: true, force: true });
  });

  it("prefers skill-forge.config.yaml and defaults to it when neither exists", () => {
    process.chdir(dir);
    expect(CONFIG_FILENAME).toBe("skill-forge.config.yaml");
    expect(projectConfigPath()).toBe(join(dir, "skill-forge.config.yaml"));
  });

  it("falls back to the legacy career-mode.config.yaml when only it exists", () => {
    writeFileSync(join(dir, "career-mode.config.yaml"), "experience_level: senior\n");
    process.chdir(dir);
    expect(projectConfigPath()).toBe(join(dir, "career-mode.config.yaml"));
  });
});
