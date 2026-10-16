import { execFileSync } from "child_process";

/**
 * Scheduling the weekly digest. Three ways, printed together so the user picks:
 *
 *   - an OS schedule (cron / Windows Task Scheduler) writing to a connector
 *     that needs no host (local, gist, notion)
 *   - a Claude Code routine (or any scheduled agent) that runs the digest with
 *     `--connector return_only` and delivers it with the agent's own connectors
 *
 * `--install` changes the user's crontab / task list, so it only happens on
 * that explicit flag; it is idempotent (marker-tagged).
 */
export interface ScheduleOptions {
  day: "MON" | "TUE" | "WED" | "THU" | "FRI" | "SAT" | "SUN";
  time: string; // HH:MM, 24h
  connector: string;
  sinceDays: number;
}

const MARK = "# skill-forge-digest";
const CRON_DAY: Record<ScheduleOptions["day"], number> = { SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6 };

export function digestCommand(o: ScheduleOptions): string {
  return `skill-forge digest --since ${o.sinceDays}d --connector ${o.connector}`;
}

export function cronLine(o: ScheduleOptions): string {
  const [h, m] = o.time.split(":").map(Number);
  return `${m} ${h} * * ${CRON_DAY[o.day]} ${digestCommand(o)} >> "$HOME/.skill-forge/logs/digest.log" 2>&1 ${MARK}`;
}

export function schtasksArgs(o: ScheduleOptions): string[] {
  return ["/Create", "/SC", "WEEKLY", "/D", o.day, "/ST", o.time, "/TN", "skill-forge-digest", "/TR", digestCommand(o), "/F"];
}

export function routinePrompt(o: ScheduleOptions): string {
  return (
    `Every ${o.day} at ${o.time}: run \`skill-forge digest --since ${o.sinceDays}d --connector return_only\`, ` +
    "then deliver the returned markdown to the destination I use for my brag doc (e.g. a Notion page, a Google Doc, or a Slack DM) with your connectors."
  );
}

export function validateSchedule(o: ScheduleOptions): void {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(o.time)) throw new Error(`--time must be HH:MM (24h), got "${o.time}"`);
  if (!(o.day in CRON_DAY)) throw new Error(`--day must be one of ${Object.keys(CRON_DAY).join(", ")}`);
  if (!/^[a-z_]+$/.test(o.connector)) throw new Error(`invalid connector "${o.connector}"`);
}

export type Exec = (cmd: string, args: string[], input?: string) => string;

const defaultExec: Exec = (cmd, args, input) =>
  execFileSync(cmd, args, { encoding: "utf-8", input, stdio: ["pipe", "pipe", "pipe"], timeout: 15_000 });

/** Install (or replace) the OS schedule. Returns a description of what changed. */
export function installSchedule(o: ScheduleOptions, platform: NodeJS.Platform = process.platform, exec: Exec = defaultExec): string {
  validateSchedule(o);
  if (platform === "win32") {
    exec("schtasks", schtasksArgs(o));
    return `Windows Task Scheduler: task "skill-forge-digest" (${o.day} ${o.time})`;
  }
  let current = "";
  try {
    current = exec("crontab", ["-l"]);
  } catch {
    current = ""; // no crontab yet
  }
  const kept = current.split(/\r?\n/).filter((l) => l.trim() && !l.includes(MARK));
  exec("crontab", ["-"], [...kept, cronLine(o)].join("\n") + "\n");
  return `crontab: ${cronLine(o)}`;
}
