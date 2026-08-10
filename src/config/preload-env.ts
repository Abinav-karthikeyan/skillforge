/**
 * Side-effect import that loads .env files immediately. Import this
 * FIRST in every process entry point (before any other import), so that
 * dotenv runs before any transitively-loaded module reads process.env
 * at its top level.
 *
 *   import "./config/preload-env.js";   // must be the first import
 *   import { Command } from "commander";
 *   …
 */
import { loadDotenvFiles } from "./env.js";
loadDotenvFiles();
