import type { NormalizedEvent } from "../normalize.js";

/**
 * Host adapters (plan_v3 §3.5). Each agent host has its own hook payload
 * shape and config file. An adapter owns both directions:
 *
 *   parse    raw hook payload → identity (session, cwd, transcript) + events
 *   install  write / remove this host's hook config, idempotently
 *
 * Adapters translate into the shared normalized event vocabulary, so the
 * redaction, detectors, observer, and reflector are identical for every host.
 */
export type HostName = "claude-code" | "codex" | "cursor" | "gemini-cli" | "copilot" | "kiro" | "git";

/**
 * How sure we are of the payload schema:
 *   verified    — fields confirmed against the host's primary docs
 *   partial     — events confirmed, some fields inferred (noted per adapter)
 *   unverified  — the docs don't publish the payload; never auto-installed
 */
export type SchemaConfidence = "verified" | "partial" | "unverified";

export interface ParsedPayload {
  /** Raw host session id; the capture layer namespaces it per host. */
  sessionId?: string;
  cwd?: string;
  transcriptPath?: string;
  events: NormalizedEvent[];
  /** Some hosts expect a JSON reply even from observers (e.g. Cursor's beforeSubmitPrompt). */
  ack?: Record<string, unknown>;
}

export interface ParseContext {
  cwd: string;
  now: Date;
}

export interface InstallContext {
  home: string;
  projectDir: string;
  scope: "user" | "project";
  /** The capture command to register (defaults to the installed bin). */
  command?: string;
}

export interface HostAdapter {
  name: HostName;
  label: string;
  confidence: SchemaConfidence;
  /** Primary documentation the adapter was written against. */
  docs: string;
  notes?: string;
  parse(raw: Record<string, unknown>, ctx: ParseContext): ParsedPayload | null;
  /** Is the host present on this machine (config dir or binary)? */
  detect(home: string): boolean;
  configPath(ctx: InstallContext): string;
  install(ctx: InstallContext): { path: string; events: string[] };
  uninstall(ctx: InstallContext): { path: string; removed: boolean };
}

export const captureCommand = (host: HostName, ctx: InstallContext) => ctx.command ?? `skill-forge-observe --host ${host}`;
export const CAPTURE_MARK = "skill-forge-observe";
