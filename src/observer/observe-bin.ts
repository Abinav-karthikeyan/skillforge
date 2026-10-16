#!/usr/bin/env node
// `skill-forge-observe` — the hook entry point for always-on capture. A
// separate bin from `skill-forge` so each hook event loads only the capture
// path (no commander, no LLM SDKs): see ./capture.ts.
import { runCaptureMain } from "./capture.js";

void runCaptureMain(process.argv.slice(2));
