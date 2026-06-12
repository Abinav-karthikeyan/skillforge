import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { parse } from "yaml";
import {
  CalibrationConfig,
  DEFAULT_CALIBRATION,
} from "../types/config.js";

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
        return { ...DEFAULT_CALIBRATION, ...parsed };
      } catch {
        // fall through to next candidate
      }
    }
  }

  return DEFAULT_CALIBRATION;
}
