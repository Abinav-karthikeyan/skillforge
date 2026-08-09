# /career-mode

Capture this coding session as a career artifact.

## What to do

1. **Synthesize a SessionSummary** from the current conversation. Extract:
   - `one_liner`: one sentence describing what was built or fixed
   - `problem_statement`: what problem was being solved
   - `approach`: how it was solved
   - `tradeoffs`: array of `{decision, reasoning, alternative_considered}` — use actual decisions from the conversation
   - `dead_ends`: things tried that didn't work
   - `technologies`: tech stack items mentioned
   - `patterns_used`: design patterns or architectural decisions
   - `complexity_signals`: `{files_touched, lines_changed, test_coverage, debugging_involved}` — estimate from context

2. **Build the JSON** in this exact shape:
```json
{
  "session_id": "<generate a uuid v4>",
  "timestamp": "<current ISO8601 timestamp>",
  "source_tool": "claude-code",
  "summary": {
    "one_liner": "...",
    "problem_statement": "...",
    "approach": "...",
    "tradeoffs": [],
    "dead_ends": [],
    "technologies": [],
    "patterns_used": [],
    "complexity_signals": {}
  }
}
```

3. **Write the JSON** to a temp file. Use a path that works on the current OS:
   - Windows: `%USERPROFILE%\.career-mode-session.json`
   - macOS/Linux: `$HOME/.career-mode-session.json`

   Run this to write it (replace `<JSON>` with the actual JSON string):
   ```bash
   echo '<JSON>' > "$HOME/.career-mode-session.json"
   ```

4. **Run the CLI** from the project root:
   ```bash
   npx tsx src/index.ts generate --mode $MODE --json "$HOME/.career-mode-session.json"
   ```
   Where `$MODE` is one of: `interview-qa`, `portfolio-bullet`, `technical-deep-dive`, or `all`.
   Default to `interview-qa` unless the user specifies a mode.

   If `ANTHROPIC_API_KEY` is not set in the environment, prepend it:
   ```bash
   ANTHROPIC_API_KEY=<key> npx tsx src/index.ts generate --mode $MODE --json "$HOME/.career-mode-session.json"
   ```

5. **Report** the output file path to the user and print the content inline so they can read it immediately.

## Notes
- You have access to the full conversation transcript — use it. The hook path only has git diffs; the slash command path is always richer.
- This command shells out to the CLI directly. If Career Mode is registered as an MCP server instead (see `docs/mcp-server.md`), prefer calling its `generate_career_artifact` tool with the same `session_summary` shape rather than shelling out — it's the same pipeline through a typed interface.
- Be specific with tradeoffs. "Used provider interface over direct Anthropic SDK because X" is better than "made architectural decisions".
- If no tradeoffs or dead ends are evident, use empty arrays — don't fabricate.
- The `complexity_signals.files_touched` and `lines_changed` can be estimated from the conversation (count files mentioned / edits made).
