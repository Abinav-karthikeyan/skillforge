---
description: Review story candidates the skill-forge observer captured, then approve or discard them
---

The skill-forge observer drafts story candidates from coding sessions in repositories the
user opted in to. Help the user review them. Nothing is published until they approve.

1. Get the candidates. Prefer the `list_story_candidates` MCP tool if it is available;
   otherwise run `skill-forge inbox` (and `skill-forge inbox show <id>` for detail).
2. If there are none, say so in one line and stop.
3. Present each candidate briefly: its title, the one-liner, and the strongest one or two
   observations (dead ends and tradeoffs first). Don't embellish them; they are the user's
   evidence.
4. Ask the user which to approve, which to discard, and which to leave for later. For
   approvals, ask which artifact they want (portfolio bullet, interview Q&A, deep-dive, or
   all), defaulting to a portfolio bullet.
5. Act only on what the user says: `approve_story` / `discard_story` over MCP, or
   `skill-forge inbox approve <id> --mode <mode>` / `skill-forge inbox discard <id>`.
6. Report what was written and where in one or two lines.

$ARGUMENTS
