# SessionSummary schema + worked example

The `--json` file (and the MCP tool's `session_summary`) must match this shape.
Fields marked optional can be omitted; arrays default to empty.

## Schema

```
{
  "session_id": string,              // stable id for this session, e.g. "auth-refactor-2026-09-26"
  "timestamp":  string,              // ISO 8601, e.g. "2026-09-26T15:00:00.000Z"
  "duration_minutes": number?,       // optional
  "source_tool": string,             // default "claude-code"
  "summary": {
    "one_liner":         string,     // one sentence: the accomplishment
    "problem_statement": string,     // what was hard / why it mattered
    "approach":          string,     // how it was actually solved
    "tradeoffs": [                   // optional; the richest interview material
      {
        "decision":               string,
        "reasoning":              string,
        "alternative_considered": string
      }
    ],
    "dead_ends":     [ string ],     // optional; false starts + what they taught
    "technologies":  [ string ],     // optional
    "patterns_used": [ string ],     // optional
    "complexity_signals": {          // optional
      "files_touched":      number?,
      "lines_changed":      number?,
      "test_coverage":      boolean?,
      "debugging_involved": boolean?
    }
  }
}
```

Only `session_id`, `timestamp`, and `summary.{one_liner, problem_statement,
approach}` are strictly required — but the more of the optional fields you fill
honestly, the better the artifact. `tradeoffs` and `dead_ends` are what turn a
flat "here's what I built" into questions a real interviewer would ask.

## Worked example

```json
{
  "session_id": "rate-limiter-2026-09-26",
  "timestamp": "2026-09-26T15:00:00.000Z",
  "duration_minutes": 90,
  "source_tool": "claude-code",
  "summary": {
    "one_liner": "Built a Redis-backed sliding-window rate limiter for the public API",
    "problem_statement": "A single tenant could exhaust API capacity; we needed per-key limits that held under bursty traffic without adding request latency.",
    "approach": "Implemented a sliding-window counter in Redis using a Lua script for atomic check-and-increment, keyed by API token, with the window and quota driven from config so limits are tunable without a deploy.",
    "tradeoffs": [
      {
        "decision": "Sliding-window counter in a Lua script",
        "reasoning": "Atomic check-and-increment avoids the race between read and write that a two-round-trip approach has under concurrency",
        "alternative_considered": "A fixed-window counter, which is simpler but allows 2x burst at window boundaries"
      }
    ],
    "dead_ends": [
      "First tried a token-bucket in application memory; it didn't hold across horizontally-scaled instances, which is what pushed the state into Redis"
    ],
    "technologies": ["Redis", "Lua", "TypeScript", "Express"],
    "patterns_used": ["Atomic Lua script", "Config-driven limits"],
    "complexity_signals": {
      "files_touched": 6,
      "lines_changed": 240,
      "test_coverage": true,
      "debugging_involved": true
    }
  }
}
```
