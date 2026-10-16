# Changelog

All notable changes to this project are documented here. This project adheres to
[Semantic Versioning](https://semver.org/) (pre-1.0: minor versions may include
back-compatible renames).

## Unreleased — v3

Work toward the v3 roadmap in `plan_v3.md`, one phase at a time.

### Phase 3.5 — Compounding: JD tailoring, gap and contribution scouts, weekly digest
- **Skill taxonomy** (`src/tailor/taxonomy.ts`): about 85 skills with aliases, categories, and
  related skills. Short and all-caps forms match case-sensitively, so "go with" isn't Go,
  "rest of" isn't REST, and "Node.js" isn't JavaScript. Adjacency orders a skill's
  neighbours nearest first: explicit relations, then reverse relations, then the rest of
  its category.
- **JD tailoring (v2 Bet 4):** `skill-forge tailor --jd <file|->` and MCP `tailor_to_job`.
  - The JD is fenced as data and parsed by the model (prompt `jd`). Keyword finds are
    merged in, injected items are dropped, and the parse falls back to keywords alone
    when the model is unavailable.
  - Stories are ranked by must-have and nice-to-have coverage, recency, and approval.
    Only decisions count as experience, never rejected alternatives.
  - The report has a coverage table and one framing angle per lead story (prompt
    `tailor-angles`). Gaps list the nearest skill the ledger does show.
  - `--generate` renders tailored artifacts into `<artifacts>/tailored/<role>/` without
    touching base stories.
- **Gap scout** (`src/discovery/career.ts`): for each gap, licensed, non-archived,
  non-fork repos with more than 1k stars from GitHub search on the allowlisted
  `api.github.com`, shown as study targets.
- **Contribution scout:** `skill-forge contribute` and MCP `find_contributions`.
  - Searches open, unassigned `good first issue` / `help wanted` issues in your top
    languages that were updated within 90 days.
  - Drops archived, unlicensed, assigned, and stale repositories.
  - Scores by stars, recency, matched libraries, and discussion load.
  - Titles are sanitized for display. Nothing is filed for you.
- **Weekly digest (v2 Bet 5):** `skill-forge digest [--since 7d]` and MCP `weekly_digest`
  (defaults to `return_only`). It catches up the reflector, collects the window's
  non-discarded stories and the structural facts of each enabled repository's commits,
  and renders a brag-doc entry (prompt `digest`) as mode `weekly-digest`. A
  deterministic fallback covers no-model runs.
- **Schedule:** `skill-forge digest schedule` prints a cron line, a `schtasks` command, and
  a Claude Code routine prompt. `--install` writes it, idempotently, with a tagged crontab
  line or a named Windows task. Day, time, and connector are validated before anything
  reaches a shell.
- New modes `jd-tailoring` and `weekly-digest` in the renderer and the index.
- Exit criteria, both tested with a mock model and a fake GitHub
  (`tests/compounding/compounding.test.ts`):
  - pasting a JD over the 5-story fixture bank returns the matching stories, 4/7
    must-have coverage, and gaps (Kafka, Kubernetes, distributed systems) with adjacent
    evidence and licensed study targets;
  - a weekly digest over a temp repository is delivered via `return_only`.

### Phase 3.4 — OSS discovery: prior art and calibration
- **Prior-art scout** (`src/discovery/`): deterministic retrieval from grep.app (`searchGitHub`),
  GitHub repository search, and DeepWiki (`ask_wiki_question`). Tool and argument names were
  confirmed with a live `tools/list` (DeepWiki's tool is `ask_wiki_question`, not the
  `ask_question` the plan assumed) and are resolved by schema at runtime. Results are ranked
  by topic and health (topic search first, then stars, recency, and license; archived,
  forked, and unlicensed repos are never cited). Evidence is pinned to `repo@SHA` with its
  license.
- **Quarantine (dual-LLM pattern):** raw repository text is sanitized (hidden Unicode, HTML)
  and seen only by a summarizer with no tools. Its ≤300-char paraphrase is validated: no
  injection markers, no URLs, no 60-char run copied from the source, otherwise dropped.
  Retrieval is deliberately not an LLM tool loop, so untrusted content can't steer what gets
  fetched.
- **Calibration scout:** a `SubagentSpec` on the `discovery` budget tier that sees only the
  quarantined summaries. It returns standard / known-variant / unusual, canonical pattern
  names, and a cited note.
- **Modes:** `discovery: off | host | direct` (default off). Host mode adds the MCP tool
  `plan_prior_art_search` (queries + evidence format for the host's own tools; no network
  from skill-forge). Direct mode is enabled by `generate --prior-art` / MCP `prior_art: true`.
  `skill-forge discover [--queries-only]` inspects queries and evidence without generating.
- **Guardrails:** a hard endpoint allowlist (`mcp.grep.app`, `mcp.deepwiki.com`,
  `api.github.com`), timeouts and byte caps, a 7-day cache, a persisted GitHub token bucket, a
  per-story call cap, and the discovery deadline. Confidential repos send no queries in
  either mode. Queries carry derived terms only (patterns, technologies, topic words),
  never summary prose or paths.
- **Artifacts:** translators get an evidence rule (cite every comparison inline; never
  compare with systems that have no evidence entry). Inline ids render as numbered footnotes
  with a Sources list of `repo @ sha · path · license — url`. The judge flags uncited
  comparisons with named external systems and caps groundedness when it finds one.
- `plan_ahead.md`'s "no skill-forge-as-MCP-client" rule is amended narrowly for allowlisted,
  read-only, no-credential discovery endpoints (plan decision 1). GitHits stays host-mode
  only, since its API is in beta and unpublished.
- Exit criteria: on the 5-story fixture bank the scout returns ≥2 cited, licensed, SHA-pinned
  comparisons per story (mocked providers), and the red-team fixture (a repository injecting
  instructions) yields no injected text in evidence or artifacts. A live run against the
  real endpoints, with a stub summarizer and no LLM spend, returned purpose-built
  rate-limiter libraries for the rate-limiter story.

### Phase 3.3 — Cross-host observation
- **Host adapters** (`src/observer/hosts/`): each adapter owns payload parsing (session, cwd,
  transcript, events) and its host's hook config. All of them translate into the shared
  normalizer, so redaction, detectors, observer, and reflector are identical across hosts.
  - Claude Code, Gemini CLI, and GitHub Copilot CLI: **verified** against primary docs (2026-10).
  - Codex CLI: **partial** (shell argv and `apply_patch` shapes inferred; no failure event,
    so exit codes come from the response).
  - Cursor: **partial** (no shell exit code, so failures are inferred from output).
  - Kiro: **unverified** (STDIN keys unpublished); never auto-installed.
  - git: `post-commit` floor.
- **git floor:** writes `post-commit` where `core.hooksPath` points (husky-safe). It appends to
  existing shell hooks, chains non-shell hooks, and uninstall restores them. Sessions are
  per repo per day. The hook runs in the background with no stdin, so a commit never waits.
- **Cross-host commit dedupe:** a commit journaled by one host (an agent's tool hook, or git's
  `post-commit`) isn't checkpointed twice, in either order.
- `skill-forge observe hosts`; `observe install --host <names…> | --all [--scope]` (`--all`
  covers only detected hosts with a verified or partial schema); `observe uninstall --host`.
  Cursor's `beforeSubmitPrompt` gets a `{continue:true}` acknowledgement so prompts are never
  blocked; Copilot's payloads get their event name via `--event`.
- **Importers:** `skill-forge import entire` (Entire CLI checkpoints through the documented
  `checkpoint list --json` / `explain --raw-transcript`; tolerant of the unpublished listing
  schema) and `skill-forge import agent-trace` (Agent Trace 0.1.0 records). Code facts gain
  `attribution` (AI / human / mixed lines) for commits with traces, and translators must
  describe AI-written work as AI-assisted.
- Exit criterion: the three gold sessions, translated into the documented payload shapes of
  Codex, Cursor, Gemini CLI, and Copilot CLI, reach 100% detector recall on every host (these
  are synthesized fixtures, not recordings).
- VS Code extension deferred to v4 (plan decision 5).

### Phase 3.2 — Always-on observer (Claude Code first)
- **Capture (hot path):** new `skill-forge-observe` bin for Claude Code hooks (SessionStart,
  UserPromptSubmit, PostToolUse(Failure), Stop, SubagentStop, Pre/PostCompact, SessionEnd).
  It normalizes, redacts, and appends to `~/.skill-forge/journal/<session>.jsonl` with
  transcript byte watermarks. No LLM and no SDK imports: about 10 ms of work per event (CI
  asserts p95 < 50 ms), about 187 ms end to end versus about 1 s for the full CLI. Off unless
  the repo is enabled; always exits 0.
- **Redaction before persistence:** 15+ token formats, JWTs, private keys, connection-string
  passwords, secret-named assignments and keys, `.env` and other secret files; file contents
  are never journaled; long output is capped. A corpus test asserts zero survivors.
- **Deterministic boundary detectors:** debugging arcs, dead ends (created-then-deleted
  files, reverts, stash/reset), dependency changes, decision language, commits, compaction
  snapshots, and flushes. 100% recall on the three replay fixtures in
  `tests/fixtures/sessions/` (synthesized from the hooks reference, not recorded).
- **Observer (warm path):** a detached, lockfiled worker turns the journal since the last
  watermark into cited, claim-sized observations with event-level evidence in the story
  ledger. It is debounced, capped per hour, uses `observer_model` (default: the provider's
  cheap tier), and runs local-only for confidential repos. Ungrounded or low-confidence
  claims are dropped.
- **Reflector (cold path):** SessionEnd spawns it detached (within the ~1.5 s budget), and
  SessionStart catches up crashed sessions. It merges observations plus code facts for the
  session's commits into versioned story candidates. Approved stories whose evidence
  changed get their living artifacts regenerated in place, through the local connector only.
- **Review inbox:** `skill-forge inbox [show|approve|discard]`, MCP tools
  `list_story_candidates` / `approve_story` / `discard_story`, and a `/skill-forge-review`
  command. Nothing is published without approval. SessionStart notifies when candidates
  wait, and opt-in question mode asks at most one question per session.
- **Backfill:** `skill-forge backfill --since 30d` replays existing Claude Code transcripts
  through the same capture path (transcripts keep pre-compaction entries).
- **Privacy controls:** `skill-forge observe enable|disable [--confidential]`, `observe
  status|install|uninstall|purge`, a 30-day raw-journal TTL, and `skill-forge forget
  --session|--repo`.
- **Claude Code plugin:** the repo root is a plugin (`.claude-plugin/plugin.json` with
  skill, commands, observer hooks, and MCP server) plus a marketplace entry. Both pass
  `claude plugin validate --strict`. Plugin hooks run through a bundled shim, so a plugin
  installed without the npm package is a silent no-op instead of "command not found".
  Verified that a detached worker outlives the capture process on Windows.
- `scripts/observer-replay.ts`: the replay eval (observer recall vs an end-of-session pass
  over what survives compaction). It uses live LLM calls, so it isn't run in CI.
- `SKILL_FORGE_HOME` overrides the config directory (tests, sandboxes, profiles).

### Phase 3.1 — Code intelligence
- **`src/codeintel/`**: entity-level structural diff (added / modified / renamed / moved /
  removed, with rename detection by masked body hash and token similarity, and
  cross-file moves), per-function cyclomatic complexity, public API changes, name-based
  test linkage and blast radius, change classification (feature / refactor / fix / test /
  config / docs, with reasons), fingerprint (languages, frameworks, added dependencies,
  pattern hints), and an Aider-style repo map (personalized PageRank within a token
  budget). Honors `.gitattributes` `linguist-generated` / `linguist-vendored`; lockfiles
  and build output never count toward metrics.
- **Optional companion `@abhinavravich1999/skill-forge-codeintel`** (`packages/codeintel`,
  an npm workspace): web-tree-sitter 0.26.13 plus vendored grammars for TypeScript, TSX,
  JavaScript, Python, Go, Java, Rust and C#, pinned and checksummed in
  `grammars/MANIFEST.json`. Core auto-detects it (L1) and degrades to git-only facts (L0)
  without it, so the base install stays light. `SKILL_FORGE_CODEINTEL=off` forces L0.
- **Structural digest in the ingestor.** The git and hook paths send a complete digest
  instead of the first 15 KB of the raw diff, plus the raw diff only when it is small
  (or as a bounded excerpt when there are no code entities to show). On this repo's last
  12 commits that is 45% of v2's prompt tokens, with no truncation (v2 truncated 6).
  `scripts/ingest-compare.ts` reproduces the comparison on any repo.
- **`code_facts`** in `SessionSummary` (layer, source, approximate flags). The ingestor
  overwrites the LLM's size estimates with measured values, and translators get a rule
  that metrics may only come from `code_facts` ("~N" for approximate counts). The judge's
  metric-honesty check treats code facts as ground truth.
- **Six scout tools:** `outline`, `find_symbol`, `references` (always `approximate: true`),
  `structural_diff`, `metrics`, `repo_map`, sandboxed and size-capped like the v2 tools,
  with lexical fallbacks at L0.
- CLI: `skill-forge codeintel status|digest|map`, `generate --range`,
  `generate --with-code-facts`; MCP: `range` and `with_code_facts` on the generate tool.
  SKILL.md tells hosts with an LSP tool how to supply precise (L2) reference counts.
- pack-smoke checks the code-intelligence layer, and CI smokes both the core alone (L0)
  and core + companion (L1) on Ubuntu and Windows.

### Phase 3.0 — Foundations
- **Judge (v2 Bet 6).** `skill-forge judge <artifact> --json <summary.json>` (or
  `--story <id>`) scores an artifact on STAR completeness, specificity, groundedness,
  metric honesty and calibration fit. Metric honesty is deterministic: every number in
  the artifact must appear in the session's ground truth. `scripts/prompt-eval.ts --judge`
  scores every eval output and writes `scores.json` plus a per-version mean table.
- **Data model v2.** Zod schemas for `ObservedEvent`, `Evidence`, `Observation` and
  `Story` (`src/types/ledger.ts`, `src/types/evidence.ts`); `projectStory()` turns a
  story back into a `SessionSummary` so translators are unchanged. `SessionSummary`
  gains optional `schema_version`, `story_id` and `summary.evidence`.
- **Story ledger + living artifacts.** Every `generate` run is recorded as a story
  in `<artifacts>/.ledger/`. `generate --story <id>` (or `story_id` over MCP) updates an
  artifact in place: `index.yml` upserts by `(story_id, mode)`, the version climbs, and
  the previous body is archived under `versions/`. Story-less writes keep the v2 append
  behaviour byte-for-byte. `skill-forge stories list|show|migrate|approve|discard`;
  legacy `index.yml` artifacts load as one-version stories.
- **Commit hook fixed.** The reference hook uses the current Claude Code schema
  (`matcher` + nested `hooks`, `if: "Bash(git commit*)"`, `async: true`) and calls the
  new `skill-forge hook post-commit` entry point instead of `npx`. The hook reads the
  payload on stdin, always exits 0, and logs to `~/.skill-forge/logs/hook.log`.
- **Named budget tiers.** `low` / `medium` (unchanged) plus `evidence` and `discovery`;
  `budgetTier()` throws on unknown names instead of silently defaulting.
- **Native tool-use runtime.** `subagent_runtime: native | claude-sdk | openai-agents`
  runs the scout's bounded tool loop through Anthropic Messages tool use or OpenAI
  Chat Completions function calling. `auto` still uses the portable inline loop.
- `LLMClient.chat()` takes optional `{ temperature, max_tokens }`; temperature is
  dropped for Claude models that reject sampling parameters.
- The CLI and MCP server report the version from `package.json` (both said `0.1.0`).
- `generate --mode` now rejects unknown modes instead of silently running deep-dive.

## 0.2.0

The "one name + host-delivery" release. Everything is now **skill-forge**, and artifacts
can be delivered by the host instead of by credentials skill-forge holds.

### Added
- **`return_only` host-delivery output mode.** `generate --connector return_only` (and the
  MCP tool's `connector: "return_only"`) writes the artifact to your local corpus **and
  returns the fully rendered markdown** with a destination-agnostic delivery instruction, so
  the host delivers it via a connector it already has — Slack, LinkedIn, Google Docs, or a
  **Gemini Notebook / NotebookLM** source (`add_source(type=text)`). skill-forge holds zero
  third-party credentials. Verified end-to-end into NotebookLM via `notebooklm-mcp-cli`.
- CHANGELOG.

### Changed — the `career-mode → skill-forge` rename (P0.1)
One name everywhere: config dir `~/.skill-forge/`, project config file
`skill-forge.config.yaml`, env var `SKILL_FORGE_PROMPT_VERSION`, the `/skill-forge` slash
command, and the MCP tools `generate_skill_forge_artifact` / `list_skill_forge_artifacts`.
User-facing strings, README, and docs all updated.

### Deprecated (still work this release, removed in the next)
- Config dir `~/.career-mode/` — still read if present (fresh installs use `~/.skill-forge/`).
- Project config filename `career-mode.config.yaml` — still read as a fallback.
- Env var `CAREER_MODE_PROMPT_VERSION` — still honored (`SKILL_FORGE_PROMPT_VERSION` wins).
- MCP tools `generate_career_artifact` / `list_career_artifacts` — still registered
  (marked `[DEPRECATED]`); switch to the `*_skill_forge_*` names.

### Migration
If you used the previous release:
- Your existing `~/.career-mode/` corpus and `career-mode.config.yaml` keep working via the
  fallbacks above — nothing to move.
- Delete the old global slash command `~/.claude/commands/career-mode.md` and install
  `/skill-forge` so you don't have both.
- The MCP **server** name was already `skill-forge`, so no `.mcp.json` change is needed.

## 0.1.0
- Initial release: typed capture pipeline (ingestor → SessionSummary → translators →
  connectors) over four surfaces (slash command, MCP server, CLI, git hook); provider
  abstraction (Anthropic / OpenAI-compatible / Ollama); local / gist / notion connectors;
  versioned-prompt eval harness; budgeted focus-scout orchestrator.
