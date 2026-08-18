# Career Mode — Roadmap

Post-P0 work. P0 (MCP server + three-interface framing) shipped in commit `d19ccd3`.
Priority is roughly ordered by credibility-per-effort for the CV project framing.
Edit freely — this is your working doc, not a spec.

---

## Status snapshot (2026-08-18)

| P | Item | Status |
|---|---|---|
| P1 | Publish to npm | ✅ Shipped (`@abhinavravich1999/skill-forge` on npm, bins `skill-forge` + `skill-forge-mcp`) |
| P2 | Demo GIF | ❌ Not started — record `career-mode auth notion` + generate flow |
| P3 | Gist connector | ✅ Shipped (`src/output/connectors/gist.ts`, `share_last_artifact` tool) |
| P4 | Tests + CI | ❌ Not started |
| P4.5 | Prompt versioning + eval | 🟡 Half shipped — versioning done, fixture bank + `scripts/prompt-eval.ts` outstanding |
| P5 | Dogfood publicly | ❌ Not started — do this **into Notion** so it validates P7.1 simultaneously |
| P6 | Show HN launch | ⏸ Blocked on P2, P4 |
| **P7** | **Destination connectors** (Notion, Linear/Jira, Obsidian, LinkedIn, Slack) | ✅ P7.1 Notion fully shipped and live-verified (see below) |
| **P8** | **Retrieval mode** (search across artifact history) | ❌ New |
| **P9** | **Session compounding** (meta-narratives across artifacts) | ❌ New |

**Recommended execution order.** P1 → P7.1 → P5 (into Notion) → P2 (Notion demo) → P4 → P4.5 completion → P8 → P6 → P7.2–P7.5 opportunistically → P9.

**Rationale for the reorder.** Original P2/P4 came before P5, but a demo GIF and test suite of a tool nobody uses daily is polish on a dead thing. P7.1 (Notion) is the single feature that turns Career Mode from "cool weekend project" to "tool I open every day" — everything else compounds off that. P5 dogfooding done *into Notion* validates both at once. The GIF then has something real to demo.

---

## P1 — Publish to npm so `npx` actually works

**Why.** The README currently says `npx career-mode` and `npx career-mode-mcp`. Neither works — nothing is on the registry. Reviewers spot this in 30 seconds and it undermines every other claim. Fixing it is a few hours of work with the highest credibility payoff.

**Steps.**
- Decide package name — `career-mode` is likely taken; check with `npm view career-mode`. Fallbacks: `@yourname/career-mode`, `career-mode-cli`, `careermode-mcp`.
- Add `"files"` field to `package.json` limiting the published tarball to `dist/`, `README.md`, `LICENSE`, `career-mode.config.yaml`. Don't ship `src/` or `tests/`.
- Add a `"prepublishOnly": "npm run build"` script so nobody ever publishes a stale `dist/`.
- Verify both bins work after install: `npx <name>` and `npx <name>-mcp`. Test in a scratch dir with `npm pack && npm install -g ./career-mode-*.tgz`.
- `npm publish` (add `--access public` if scoped).
- Update the README's install section to remove `git clone`; the primary path becomes `npx <name>` or `npm install -g <name>`.

**Done when.** A fresh machine with only Node installed can run `npx <name> generate --help` and `claude mcp add career-mode -- npx <name>-mcp` without cloning anything.

**Notes.**
-

---

## P7.1 — Notion connector (promoted above P2/P4)

**Why.** The current output surface — local `.md` files + a Gist connector — is a dead end for daily use. Nobody reads their `~/.career-mode/artifacts/` folder. Artifacts need to land where career work actually happens, and for most engineers that's Notion (brag docs, interview prep, running "wins" databases). This is the single change that makes Career Mode a tool you open every week instead of a weekend project.

**Design.**
```
src/output/connectors/notion.ts   # NotionConnector implements CareerModeConnector
scripts/notion-setup.ts           # creates the target database with correct schema
```

Config additions (`career-mode.config.yaml`):
```yaml
connector: notion
notion_token: ${NOTION_TOKEN}
notion_database_id: ${NOTION_DATABASE_ID}
# optional column mapping if user's DB uses different property names
# notion_property_map:
#   title: "Story"
#   mode: "Type"
#   one_liner: "Summary"
```

Target database schema (created by `notion-setup.ts`):
- `Title` (title) — from `one_liner`
- `Mode` (select: interview-qa | portfolio-bullet | technical-deep-dive)
- `Date` (date) — from `timestamp`
- `One-liner` (rich_text)
- `Technologies` (multi_select) — from `technologies[]`
- `Patterns` (multi_select) — from `patterns_used[]`
- `Prompt Version` (rich_text) — for provenance
- Page body: rendered markdown, converted to Notion blocks

**Steps.**
- Add `@notionhq/client` dependency.
- Implement `NotionConnector.write(output, session)`: create page in the configured database, convert markdown → Notion blocks (use `martian` or a small handwritten converter; martian is fine).
- Wire into `createConnector` factory.
- Add MCP tool `push_to_notion` (or extend `share_last_artifact` with a `destination: gist | notion` param — probably cleaner).
- Write `scripts/notion-setup.ts` — accepts a parent page ID, creates the database with the right schema, prints the database ID for the user to paste into config. This is where users bounce otherwise.
- Update README with a Notion setup section — one paragraph on integration token creation, one on running the setup script.

**Done when.** `career-mode generate --connector notion` creates a real Notion page in the configured database with a rendered artifact and the right property values populated. `push_to_notion` MCP tool works from Claude Code.

**Status: ✅ Shipped and live-verified (2026-08-18)**

What shipped beyond the original spec:
- `career-mode auth notion` — interactive guided setup (style: `gh auth login`): masked token prompt, live API validation, page picker from `/search`, raw-fetch database creation, atomic write to `~/.career-mode/.env` + `config.yaml`
- `career-mode auth status` — shows which connectors are configured
- `notion_auth_status` MCP tool — read-only status check from any MCP host
- `src/auth/notion.ts` + `src/auth/config-writer.ts` — auth module with safe `.env`/YAML merge writers
- Fixed: `@notionhq/client` v5 strips `properties` from `databases.create` — switched to raw `fetch()` with `Notion-Version: 2022-06-28`

Live-verified:
- `generate --connector notion` — both `interview-qa` and `portfolio-bullet`; all properties (Title, Mode, Date, One-liner, Technologies, Prompt Version) populated in Notion
- `share_last_artifact destination:notion` via MCP — confirmed via `scripts/test-share-notion.ts`

**Notes.**
-

---

## P5 — Dogfood publicly (do this *into* Notion)

**Why.** The architectural story is solid but the *quality* story is unproven — nobody has run this on 10 real sessions and looked at the outputs. Until that happens, the whole thesis ("structured output beats a naive prompt") is a claim. Fixing this needs no code, just discipline.

**Do this after P7.1 so dogfooding validates both simultaneously** — every session pushes into your real Notion brag doc, and after 10 sessions you have opinions on both prompt quality and Notion UX.

**Steps.**
- Use `/career-mode --connector notion` at the end of the next 10 real coding sessions.
- After 10, read them cold in Notion (where you'd actually use them). For each, ask: would I actually reach for this in an interview or resume rewrite without heavy editing?
- Two possible outcomes:
  - **They're good enough.** Pick the best 2–3 artifacts, redact identifying detail, publish them in `docs/sample-artifacts/`, and link them from the README's "Sample outputs" section. This is the empirical proof.
  - **They're not good enough.** The prompts need iteration. Log which fields consistently underperform and fix those prompt files. This is 30% of the value of the whole project per the PRD, so budget real time.
- Bonus: write one blog post — "I used my own tool to prep for my last interview. Here's what worked and what didn't." This is the recursive proof-of-value.

**Done when.** The README has a "Sample outputs" section pointing at real artifacts generated from real sessions, and you have honest notes on which modes work and which don't.

**Notes.**
-

---

## P2 — Demo GIF in the README (record the Notion flow)

**Why.** For a developer tool, "watch it work in 20 seconds" beats any amount of prose. The README currently has zero visual proof.

Deferred behind P7.1 + P5 because the strongest demo is `/career-mode` in Claude Code → artifact appearing live in a Notion database. That's a much more compelling 20 seconds than a terminal printing a file path.

**Steps.**
- Record a short session (~30s max). Recommended flow:
  1. Show a Claude Code session ending with `/career-mode`.
  2. Cut to the Notion database — new row appears, click into it, show the rendered artifact.
- Recording tool: real GIF via ScreenToGif / LICEcap since you need to show Claude Code UI + browser. Keep under ~3 MB.
- Embed at the top of the README, above "The problem" section.

**Done when.** The README opens with a moving image showing the end-to-end flow. Test the render in incognito on the GitHub page.

**Notes.**
-

---

## P4 — Real test suite + CI

**Why.** Right now correctness rests on one smoke script. For a project framed as engineering-craft, having zero tests is the second thing a reviewer notices missing (after the missing demo). This also protects you from regressions as you iterate — increasingly relevant once P7 adds more connectors.

**Steps.**
- Pick a runner. Vitest is the low-friction choice (native TS/ESM, no config drama).
- Unit tests worth writing first:
  - `ingestSession` — fence-stripping (`stripFences`), schema validation on malformed input, session_id/timestamp filling.
  - `renderMarkdown` — frontmatter shape stable across modes.
  - Each translator's `interpolate` — placeholders replaced, missing keys don't crash.
  - `LocalFileConnector.write` — filename slug, `index.yml` append idempotency.
  - `NotionConnector` — markdown→blocks conversion, property mapping (mock the Notion API).
  - `GistConnector` — payload shape (mock fetch).
- Add one integration test that spawns the MCP server (reuse the pattern from `scripts/mcp-smoke-test.ts`) and asserts `tools/list` matches.
- CI: GitHub Actions workflow running `npm ci && npm run build && npm test && npx tsc --noEmit` on Node 20 + 22, Ubuntu + Windows. Add a status badge to the README.

**Done when.** `npm test` passes locally; a green CI badge sits at the top of the README next to the npm version badge.

**Notes.**
-

---

## P4.5 — Prompt versioning + eval baseline (finish the second half)

**Why.** The core thesis ("structured beats naive prompting") is architectural until the prompts are demonstrably good. Versioning is shipped (`manifest.yaml`, versioned dirs, `prompt_version` in frontmatter, `--prompt-version` CLI flag). What's outstanding is the empirical loop: a fixture bank + `scripts/prompt-eval.ts` so you can diff two prompt versions side-by-side.

**Already shipped.**
- `src/prompts/<mode>/v1.txt` layout
- `manifest.yaml` with active version per mode
- `loadPrompt` with override precedence (CLI flag > env > manifest)
- `prompt_version` in artifact frontmatter

**Still to do.**
- Grow the fixture bank: add ~4 more session fixtures covering different shapes (debugging-heavy, greenfield feature, refactor, ML/data). Currently there's one.
- New `scripts/prompt-eval.ts`: takes fixtures × versions × modes, runs each, writes outputs to `test-output/eval/<timestamp>/<mode>-<version>/<fixture>.md` for side-by-side manual review.

**What's explicitly out of scope for the baseline.** Automated quality scoring (LLM-as-judge or heuristic rubric). Worth adding only after you have 2–3 versions and want regression signal.

**Honest caveat.** An eval harness answers "did I regress?" — not "is this useful in a real interview?" The two questions need two loops: eval catches regressions, P5 dogfooding proves real-world value. Neither alone closes the empirical gap.

**Done when.** `npx tsx scripts/prompt-eval.ts` produces a comparison folder you can diff two prompt versions in.

**Notes.**
-

---

## P8 — Retrieval mode

**Why.** Once you have 50+ artifacts, the *retrieval* problem becomes real: "give me my best distributed-systems interview answer" or "find the artifact where I designed a rate limiter." An unindexed pile of 100 artifacts is worse than 10; a searchable one is 10× better. This is where the value compounds — Career Mode stops being a write-only journal and becomes a queryable interview-prep corpus.

**Design.**
- `career-mode search "<query>"` CLI command.
- Embeddings over `SessionSummary.one_liner + problem_statement + approach + technologies.join(' ')`.
- Embedding provider: reuse the configured LLM provider (OpenAI-compatible → `text-embedding-3-small`, Anthropic has no embeddings API → fall back to `openai-compatible` with the same key, or use a local option via Ollama). Document the fallback clearly.
- Index storage: flat file (`~/.career-mode/embeddings.json`) — no need for a vector DB at this scale. Rebuild on demand with `career-mode reindex`.
- MCP tool `search_career_artifacts(query, limit)` for use inside Claude Code sessions ("help me find the artifact where I built X").

**Steps.**
- Add embedding call to `LLMClient` interface (currently only chat completions).
- New `src/retrieval/index.ts` — build/query the embedding index.
- Wire `search` command in `src/index.ts`.
- Add `search_career_artifacts` MCP tool.
- Auto-append to the embedding index whenever a new artifact is written (small hook in each connector, or in the renderer).

**Done when.** `career-mode search "rate limiter"` returns the relevant artifact from a corpus of ≥20. The MCP tool works inside Claude Code.

**Notes.**
-

---

## P6 (stretch) — Show HN launch

**Why.** MCP is having a moment. "I built an MCP server that turns coding sessions into a self-writing Notion brag doc" is a stronger hook than the original three-interface framing. Only worth doing after P1, P2, P7.1 are in place — a Show HN on a rough repo is worse than no launch.

**Steps.**
- Pre-check: npm install works cold, GIF renders and shows Notion flow, MCP registration one-liner works, sample artifacts exist, Notion setup script is smooth.
- Draft the post: what it is (one sentence), the problem (two sentences), the design choice worth talking about (typed schema between ingestion and translation, or the connector interface with Notion/Gist/Obsidian), a link to a sample artifact.
- Post 9–11am ET, weekday. Reply to every comment for the first 6 hours.
- Cross-post: r/LocalLLaMA (Ollama angle), r/ClaudeAI, r/Notion (the integration angle), Twitter/X with the GIF.

**Done when.** Post is live. Star count, issues, or forks is the signal — not upvotes.

**Notes.**
-

---

## P7.2 — Linear / Jira back-references

**Why.** Tradeoffs and dead-ends in a `SessionSummary` are exactly the raw material for an engineering journal entry linked to a ticket. If the ingestor detects ticket IDs in the git log (`PROJ-1234`, `#456`), the artifact can be pushed as a comment on the ticket — turning Career Mode into a passive engineering-journal generator for teams that live in Linear/Jira.

**Design.**
- Ticket-ID regex in the ingestor writes detected IDs into `SessionSummary.linked_tickets` (new optional field on the schema).
- `LinearConnector` (GraphQL) / `JiraConnector` (REST) post the artifact as an internal comment on the detected ticket.
- Bonus: a new mode `engineering-journal` tuned for internal audiences (blameless retrospective tone) rather than interview optics.

**Steps.**
- Extend `SessionSummarySchema` with `linked_tickets: string[]`.
- Detection regex in `ingestSession` — configurable prefix pattern via config (`ticket_pattern: "PROJ-\\d+"`).
- Implement `LinearConnector` first (single GraphQL endpoint, simpler auth than Jira).
- New `engineering-journal` translator + prompt.

**Done when.** A session on a branch named `feat/PROJ-1234-thing` produces an artifact that gets posted as a comment on the Linear ticket.

**Notes.**
-

---

## P7.3 — Obsidian / local vault connector

**Why.** The most privacy-conscious slice of the target audience (senior/staff engineers at large cos) will refuse cloud destinations. Obsidian is just markdown in a folder — trivial to support and signals "we respect your workflow."

**Design.**
- `ObsidianConnector` extends `LocalFileConnector` with:
  - Configurable vault path (`obsidian_vault_path`).
  - `[[wikilink]]` renderer — link `technologies` to `technology/<name>` pages, `patterns_used` similarly.
  - Optional daily-note append mode: append the artifact under a `## Career Mode` heading in today's daily note.

**Steps.**
- New `src/output/connectors/obsidian.ts`.
- Wikilink renderer helper.
- Daily-note append logic (find today's note via configurable date format, create if missing).

**Done when.** Configured vault gets new artifact files with wikilinks that Obsidian resolves. Optional daily-note mode works.

**Notes.**
-

---

## P7.4 — LinkedIn draft export

**Why.** The `portfolio-bullet` mode is *already* the raw material for a LinkedIn "featured" post or About section. Right now users have to copy-paste. Closing the loop on "session → shipped brand asset" is high-visibility even if it's just a URL trick.

**Design.**
- Start with the URL-draft path: `career-mode share --linkedin` opens `https://www.linkedin.com/sharing/share-offsite/?url=<gist-url>&text=<encoded-bullet>` in the browser. No OAuth dance, works today.
- Later: full API integration behind a token, gated behind explicit user opt-in per post (never auto-post to social).

**Done when.** `career-mode share --linkedin` opens a LinkedIn compose window pre-filled with the last portfolio bullet.

**Notes.**
-

---

## P7.5 — Slack DM / channel connector

**Why.** For teams that do "wins Wednesdays" or weekly brag threads. Pairs naturally with the git commit hook: every commit → weekly digest → Slack DM to self. Turns the whole pipeline into a background career-hygiene daemon.

**Design.**
- Webhook URL in config (`slack_webhook_url`) — dead simple, no OAuth.
- `SlackConnector` posts the artifact one-liner + a link (Gist URL or Notion URL if configured together) to the webhook.
- Bonus: a weekly digest command (`career-mode digest --week`) that summarizes the last 7 artifacts into a single Slack-friendly message.

**Done when.** Configured webhook receives artifact notifications on generate. Weekly digest command works.

**Notes.**
-

---

## P9 — Session-to-session compounding

**Why.** Right now each session is independent. But if the ingestor could read the last N artifacts and detect patterns ("you keep solving auth problems — here's a meta-narrative for your resume") you get a **career trajectory** view rather than a session diary. This is the feature nobody else can build without the typed schema you already have — a genuine differentiator worth calling out in the README and any launch post.

**Design.**
- New mode `career-narrative` — reads the last N `SessionSummary` records from `index.yml`, sends them to the LLM with a synthesis prompt, produces a 1–2 paragraph "trajectory" describing recurring themes, technical range, and inferred growth areas.
- Depends on P8 (retrieval) for the clustering signal: use embeddings to detect thematic clusters before synthesis, so the narrative isn't just "here's the last 10 things" but "here are the 3 themes that dominated the last 6 months."
- Output modes:
  - `career-mode narrative --window 3mo` → quarterly self-review draft.
  - `career-mode narrative --theme "distributed-systems"` → focused narrative for a specific interview.

**Steps.**
- Blocked on P8 — do that first.
- Add `career-narrative` translator with a synthesis prompt.
- Clustering logic in `src/retrieval/` (k-means over embeddings, or simple threshold-based grouping).
- New CLI subcommand `narrative`.

**Done when.** `career-mode narrative --window 3mo` produces a coherent trajectory paragraph from a corpus of ≥15 real artifacts.

**Notes.**
-

---

## Explicitly out of scope

Two ideas that sound good but probably aren't:

1. **A web dashboard.** Tempting, but it competes with Notion and loses. The value of Career Mode is meeting users where their career docs already live, not creating a new place.
2. **Multi-user / team mode.** Career artifacts are inherently personal — the moment they're shared with a manager, the incentives corrupt the content. Keep it strictly single-user.
