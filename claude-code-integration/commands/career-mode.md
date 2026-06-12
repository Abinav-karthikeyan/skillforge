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
  "session_id": "<generate a uuid>",
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

3. **Write the JSON** to `/tmp/career-mode-session.json`

4. **Run the CLI**:
```bash
npx career-mode generate --mode $MODE --json /tmp/career-mode-session.json
```
Where `$MODE` is one of: `interview-qa`, `portfolio-bullet`, `technical-deep-dive`, or `all`.
Default to `portfolio-bullet` unless the user specifies.

5. **Report** the output file path(s) to the user.

## Notes
- You have access to the full conversation transcript — use it. The hook path only has git diffs.
- Be specific with tradeoffs. "Used Redis over in-memory cache because X" is better than "made architectural decisions".
- If no tradeoffs or dead ends are evident, use empty arrays — don't fabricate.
