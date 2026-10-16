# skill-forge v3 — Research & Roadmap

> **Scope:** research and a proposed plan for three v3 pillars:
> (A) code intelligence via AST/LSP, (B) an always-on observer that captures the active
> session and produces artifacts incrementally, and (C) subagents that discover open-source
> repos and use them to enrich artifacts (in the spirit of GitHits).
>
> *Companion to `plan_ahead.md`, which stays the v2 roadmap of record. Researched
> 2026-10-16 against the code at `71c3bca` (branch `v2`).*
>
> Claims marked **[unverified]** came only from third-party pages, mirrors, or vendor
> marketing, and I could not confirm them against a primary source. Check them before
> building on them.

---

## TL;DR

v3 changes skill-forge from **an end-of-session summarizer** into **an ambient career
evidence engine**. It watches work as it happens, grounds every claim in deterministic
code facts, and cites how the rest of the ecosystem solved the same problem.

The main risk is drift. All three pillars sit next to tools built for *writing code*
(Serena, GitHits, claude-mem). skill-forge's job is different: it turns work into
**artifacts the user can defend in an interview**. Each pillar has to justify itself in
those terms.

| Pillar | What it is | Career value (the reason to build it) | Build or borrow | Order |
|---|---|---|---|---|
| **A. Code intelligence** | tree-sitter structural diff, symbol graph, complexity metrics, repo map. LSP when the host has it. | **Quantified, honest claims.** "Cut cyclomatic complexity of the auth path from 31 to 12." "Changed a module referenced by 37 files." Feature, refactor, or fix? Classified from structure, not guessed from the diff. | Build a thin layer on web-tree-sitter. Borrow LSP from the host. | **1st** |
| **B. Always-on observer** | Hooks into Claude Code, Codex, Gemini, Cursor, Copilot, and git feed a local journal. Deterministic boundary detection, then a cheap observer pass, a story ledger, and living artifacts. | **Captures what git never sees, live.** Dead ends, rejected alternatives, debugging arcs. These are also lost at *compaction*, not just when the terminal closes. Commit-based tools (bragdoc, bragbot, brag-ai) never see them. Transcript readers (Career Harvest, claude-mem) read *after the fact* and aren't typed, evaluated, or grounded in code facts. | Build capture and distillation. Interoperate with Entire and Agent Trace. | **2nd** |
| **C. OSS discovery subagents** | Prior-art, calibration, contribution, and gap scouts over grep.app, DeepWiki, GitHub, and (optionally) GitHits. | **Comparative evidence.** "Envoy and Kong solve this with X. You chose Y because Z." That is a system-design answer. Plus calibration (standard or novel?) and skill-matched contribution targets. | Borrow the indexes. Build only the scouts and the evidence schema. | **3rd** |

**Why this order (dependency, not preference):**
- An always-on observer is only affordable when the per-event signal is **deterministic
  and LLM-free**. Pillar A supplies that: structural diffs and metrics computed at
  boundaries.
- Discovery needs a **fingerprint** of what was built (symbols, patterns, dependencies)
  to form good queries. Pillar A supplies that too.
- Discovery is also the pillar with the most external risk: vendor betas, rate limits,
  prompt injection, licensing.

**The real v3 change is the data model, not any one pillar.** Today it is a one-shot
`SessionSummary` with an append-only `index.yml`. v3 moves to
**Event → Observation → Story → Artifact(version)**, with **Evidence** carrying provenance
at every step. `SessionSummary` survives as a *projection* of a story, so the existing
translators keep working unchanged.

---

## 0. Where v2 leaves us: code facts that shape v3

Verified against the repo, not taken from earlier docs:

- **Pipeline:** `ingestor → SessionSummary → translators → connectors`, exposed four ways
  (slash command, MCP, CLI, git hook), plus a portable `skills/skill-forge/SKILL.md` (`71c3bca`).
- **The orchestrator is the moat and already has the seams v3 needs:**
  - `SubagentRuntime` (`src/orchestrator/subagent/types.ts`) reserves `claude-sdk` and
    `openai-agents` slots. `factory.ts` currently maps both to `InlineRuntime`.
  - `ToolDef` (`subagent/tools/types.ts`) is runtime-agnostic: a Zod schema plus a string
    handler.
  - The sandboxed registry (`subagent/tools/registry.ts`) has `grep`, `read_file`,
    `list_files`, and `git_log`, with path-escape guards and result caps.
  - `runToolLoop` (`tool-loop.ts`) runs a JSON-envelope tool loop over plain chat, so it
    works on any provider, including Ollama.
- **`BUDGETS.low` has `max_tool_calls: 0`** (`src/orchestrator/focus.ts:28`). At the
  default tier the scout uses no tools. Every v3 feature that relies on the scout has to
  name its tier explicitly. (This was already flagged in `plan/implementation-phases.md`.)
- **The git path is lossy.** `gatherGitContext()` (`src/adapters/claude-code.ts`) sends
  `git diff HEAD~1 HEAD --stat --unified=3` **truncated at 15 KB**, plus 10 log lines, to
  one LLM call. Large changes are cut off mid-stream, and every claim about complexity is
  the model's guess. Pillar A fixes this directly.
- **The data model is one-shot.** `SessionSummarySchema` (`src/types/session.ts`) is a
  single pass, and `complexity_signals` is four optional, LLM-estimated fields.
  `index.yml` is append-only. Nothing supports "update the artifact as the session
  evolves."
- **The documented commit hook doesn't match Claude Code's current hook schema.** This
  affects README §5 and `claude-code-integration/hooks/post-session.json`:
  - The current schema nests handlers as
    `PostToolUse: [{ matcher, hooks: [{ type: "command", command, if, async }] }]`.
  - `pattern` is not a field. Filtering on the command uses `if` with permission-rule
    syntax, e.g. `Bash(git commit*)`. Confirm the exact pattern in the hooks reference.
  - As written, the hook also runs a **synchronous** `npx` generation: a cold `npx`
    resolve plus two LLM calls.
  - It is listed as untested (P0.3). Fixing it is step zero of Pillar B.
- **Minor:** the MCP server still reports `version: "0.1.0"` (`src/mcp/server.ts:33`),
  while the package is `0.2.0`.
- **Status of v2 bets:**
  - Bet 3 (evidence engine) is absorbed into Pillars A and C.
  - Bet 5 (weekly digest) becomes the Reflector schedule in Pillar B.
  - Bet 4 (JD tailoring) pairs with the gap scout in Pillar C.
  - Bet 6 (LLM-as-judge) becomes a **prerequisite**: without a score, there's no way to
    show any pillar improved the artifacts.

### Competitive read: where the moat actually is

| Tool | Input | Output | What it can't see |
|---|---|---|---|
| bragdoc CLI | local git commits, scheduled, incremental | scored achievements | the *why*: tradeoffs, dead ends |
| bragbot / brag-ai / promoteme | git log or GitHub PRs | brag doc | same |
| Career Harvest (agent skill) | CC transcripts + git + GitHub | XYZ bullets | no typed pipeline, no evals, no code facts **[unverified]** |
| GitResume, RepoToResume, etc. | public repo + optional JD | resume bullets, interview Qs | anything private or live |
| claude-mem | CC hooks → compressed observations | *coding* memory injected into the next session | not career-shaped |
| Entire CLI | agent and git hooks → checkpoints linked to commits | audit trail, resume | not career-shaped |

skill-forge's defensible position combines three things:
1. **transcript-only facts**, captured live
2. **deterministic code facts** (Pillar A)
3. **typed, calibrated, evaluated output**

Commit-based tools can't get (1). Transcript tools don't do (2) or (3).

---

## 1. Principles for v3 (extending `plan_ahead.md`)

1. **Career value, not coding assistance.** Every capability has to end as a claim in an
   artifact that the user can defend. If a feature helps an agent *write* code, it
   belongs to another product.
2. **Deterministic first, LLM last.** Parse, diff, measure, and detect boundaries without
   a model. Spend tokens only on distillation and writing.
3. **Compose host capabilities, and keep an in-process floor.** Use the host's LSP, MCP
   servers, and hooks when they exist. Fall back to tree-sitter, direct no-auth HTTP, and
   git hooks. This mirrors the existing `InlineRuntime`-as-floor pattern.
4. **Evidence has provenance.** Every number or comparison in an artifact traces to a
   journal event, commit SHA, symbol, or URL plus SHA. The judge enforces this.
5. **Local-first, opt-in, redacted.** Observation is off by default and enabled per repo.
   Secrets are redacted *before* anything is persisted.
6. **Measure or don't ship.** Each pillar's exit criterion is an eval delta, not "it runs."

---

## 2. Pillar A: Code intelligence (AST / LSP). Build first.

### 2.1 Research: how coding agents get structural understanding

**Retrieval strategy (index vs. agentic search)**
- Claude Code started with off-the-shelf vector RAG (Voyage embeddings) and moved to
  **agentic search** (grep/ls/cat in a loop). The reasons cited were simplicity and
  avoiding staleness, privacy, and security problems. Boris Cherny described the evidence
  as mostly "vibes" plus some internal benchmarks (secondary reports of a 2025 podcast).
- Cursor still builds an **embedding index**: AST-aware chunking, remote vector store,
  **Merkle-tree** hash sync so only changed subtrees re-upload, and simhash reuse of a
  teammate's index.
- **Implication:** skill-forge needs *facts about a change*, not concept search over a
  huge repo. Agentic and on-demand parsing fits. This **reaffirms** `plan_ahead.md`'s
  "no vector store" rule.

**Repository maps**
- Aider parses every file with tree-sitter using modified `tags.scm` queries. It extracts
  definitions and references, builds a file graph, ranks it with a graph-ranking
  algorithm, and emits the top signatures within `--map-tokens` (**default 1k tokens**).
- Ports (RepoMapper and Go clones) describe it as PageRank personalized toward the files
  in the chat, with binary search to fit the budget and a cache invalidated on file
  change.

**tree-sitter in Node**
- `node-tree-sitter` (native) uses prebuilds or node-gyp.
- `web-tree-sitter` (WASM) behaves the same on every OS and avoids native builds.
  - Its README says WASM in Node is "considerably slower" than native. For per-change
    parsing that cost is negligible.
  - Prebuilt grammar WASM bundles exist for 40+ languages.
- **For an npm and `npx` package that must run on Windows, inside unknown hosts, WASM is
  the safe floor.** This is the same reasoning as P0.2.

**Structural search**
- `@ast-grep/napi` is a native addon with Windows binaries. Older docs list JS-API
  language support as html/js/jsx/ts/tsx only **[unverified, check current]**.
- It is useful for pattern queries, but too narrow to be the foundation.

**LSP for agents**
- **Claude Code** has a built-in LSP tool with `goToDefinition`, `findReferences`,
  `documentSymbol`, `hover`, and `getDiagnostics`. Language servers come from plugins
  (e.g. the `boostvolt/claude-code-lsps` marketplace: pyright, vtsls, rust-analyzer,
  clangd…), and the server binary is installed separately. Early 2.0.x builds had a
  plugin-loading race **[community sources]**.
- **Serena** is an MCP toolkit with symbol-level tools (`find_symbol`,
  `find_referencing_symbols`, `insert_after_symbol`) over LSP for 40+ languages, or a
  paid JetBrains backend. Its LSP layer (`solidlsp`) derives from Microsoft's `multilspy`
  **[aggregator sources]**.
- Thin "mcp-language-server" bridges expose only definition, references, and diagnostics.

**Precomputed indexes**
- **SCIP** (Sourcegraph) is a protobuf index format with indexers for TS/JS
  (`scip-typescript`), Python, Java, Rust, C/C++, Ruby, .NET, Dart, and PHP.
- A third-party `scip-cli` converts SCIP to SQLite for agent queries.

**Semantic and structural diff**
- **GumTree**: language-independent AST differencing.
- **RefactoringMiner 3.0**: refactoring-aware. It had **0** semantic violations in a 2024
  benchmark, against 190–629 for GumTree variants (arXiv 2403.05939), but it is
  Java-focused.
- **difftastic**: structural diff over tree-sitter, 50+ languages.
- **sem** (2026): entity-level added/modified/deleted/moved/renamed tracking over git,
  using tree-sitter, 32 languages **[unverified]**.

**Complexity metrics**
- lizard: Python, cyclomatic only, many languages.
- rust-code-analysis: Mozilla, tree-sitter, MPL-2.0, slow release cadence.
- Arborist: Rust, cyclomatic plus SonarSource cognitive complexity, 12 languages.
- codemetrics: Go, 17 languages.
- None of them is a drop-in Node dependency, so a small tree-sitter visitor for
  cyclomatic complexity (and cognitive complexity later) is cheap to own.

### 2.2 What it buys skill-forge

| Capability | Artifact improvement |
|---|---|
| **Entity-level structural diff** (added/modified/removed/renamed functions, classes, types) | Replaces the truncated 15 KB raw diff in the ingestor with a compact, complete digest. It never cuts off mid-change, and the token count drops. |
| **Change classification** (feature / refactor / fix / test / config) from entity changes plus test linkage | Mode selection and framing: a refactor story and a feature story are told differently. |
| **Complexity delta** per touched function | Honest **XYZ bullets** with real numbers. Prompts may use *only* these numbers for metrics. |
| **Public API surface change** (exports, interfaces, route handlers) | "Designed the `LLMClient` interface now implemented by 3 providers." A strong design signal. |
| **Reference counts and centrality** of touched symbols (blast radius) | "Changed a hub module referenced from 37 files." A seniority signal. Labeled approximate unless LSP-backed. |
| **Test linkage** (tests that reference changed symbols) | `test_coverage` becomes a fact instead of a guess. |
| **Repo map** (ranked signatures within a budget, personalized to changed files) | Gives the scout and `technical-deep-dive` architecture context cheaply. |
| **Fingerprint** (languages, frameworks, dependencies, pattern names, key symbols) | Input to Pillar C queries and Pillar B boundary heuristics. |

### 2.3 Design

**A layered floor, with opportunistic upgrades:**

| Layer | Source | When | Precision |
|---|---|---|---|
| L0 | regex/grep (exists) | always | lexical |
| **L1** | **web-tree-sitter + tags queries** | default when the code-intel package is present | syntactic; name-based references are *approximate* |
| L2 | **host LSP**: Claude Code LSP tool or VS Code language features, via SKILL.md instructions; *or* a language server the user already has on `PATH` (`typescript-language-server`, `pyright`, `gopls`) | `medium` effort or above, only if present | semantic; precise references |
| L3 | existing SCIP index or Sourcegraph MCP via host | if present | semantic, cross-repo |

**New module `src/codeintel/`:**
- `parser.ts`: lazy grammar loader and a parse cache keyed by content hash (a
  Merkle-style idea without a server).
- `entities.ts`: definitions and references from `tags.scm`-style queries.
- `structural-diff.ts`: entity matching between two revisions (signature plus body-hash
  similarity, so renames are detected).
- `metrics.ts`: a cyclomatic visitor (cognitive complexity later).
- `repo-map.ts`: personalized PageRank over the reference graph, fit to a token budget.
- `fingerprint.ts`.

**New scout tools** registered in `subagent/tools/registry.ts`, under the same sandbox and
caps:
- `outline(path)`
- `find_symbol(name)`
- `references(symbol)`: returns `approximate: true` at L1
- `structural_diff(rev_range)`
- `metrics(path|symbol)`
- `repo_map(budget_tokens)`

**Schema:** add a deterministic `code_facts` block next to `complexity_signals`. Each fact
carries `source: "ast" | "lsp"` and `approximate` flags. Translator prompts are told:
*"metrics and counts may only come from `code_facts`."*

**Packaging:**
- Ship as an **optional companion package** (e.g. `@abhinavravich1999/skill-forge-codeintel`)
  with a fixed set of starter grammars: TS/JS, Python, Go, Java, Rust, C#.
- Core detects it and degrades to L0 if it is absent, so the base `npx` install stays
  light.
- No runtime download of grammars, because that is a supply-chain surface.

### 2.4 Non-goals
- No editing or refactoring tools. That's Serena's job.
- No embeddings or persistent semantic index. The parse cache is keyed by file hash only.
- No bundled language servers and no LSP lifecycle manager. Use the host's, or one the
  user already installed.

### 2.5 Risks
- **Per-language query maintenance.** Start with six languages and add on demand.
  Contract-test each grammar against fixture snippets.
- **Approximate references overclaiming.** At L1, never render precise counts in
  artifacts ("~37 references"). Precise counts require L2.
- **Generated or vendored code inflating metrics.** Honor `.gitattributes`
  `linguist-generated`/`linguist-vendored` and extend `IGNORED_DIRS`.
- **Package size.** Measure grammar WASM size before choosing the starter set.

### 2.6 Exit criteria
- The git and hook ingest path uses the structural digest. No truncation on fixture
  repos.
- On the 5-fixture bank, the judge's **specificity** and **metric-honesty** scores go up
  versus v2, and ingest tokens go down.
- `pack-smoke` passes on Windows and Ubuntu with and without the code-intel package.

---

## 3. Pillar B: Always-on observer. Build second.

### 3.1 Thesis
skill-forge's founding line is that "session context dies when the terminal closes." In
2026 it also dies **at every compaction**. By the end of a long session, a `/skill-forge`
pass sees a summarized transcript, and the dead ends are the first thing compaction
drops. Commit-based competitors never see them at all. The observer captures them *when
they happen*.

### 3.2 Research: event sources across hosts

**Claude Code hooks** (official reference, fetched 2026-10-16):
- **33 events**, including:
  - session: `SessionStart`, `SessionEnd`
  - turn: `UserPromptSubmit`, `Stop` (carries `last_assistant_message`)
  - tool: `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PostToolBatch`
  - subagents and tasks: `SubagentStart`, `SubagentStop`, `TaskCompleted`
  - compaction: **`PreCompact` / `PostCompact`**
  - filesystem: `FileChanged`, `CwdChanged`, `WorktreeCreate`
- Common input includes `session_id`, `prompt_id`, `cwd`, `agent_id` (inside
  subagents), and **`transcript_path`**. The docs warn that the transcript file is
  written asynchronously and **may lag**.
- Handler types: `command` (supports **`async: true`** to run in the background, and
  `asyncRewake` to wake Claude on exit 2), `http` (POSTs the JSON), **`mcp_tool`** (calls
  a tool on a configured MCP server), `prompt`, and `agent` (experimental).
- Default timeouts: 600 s for command/http/mcp_tool. **`SessionEnd` gets a shared 1.5 s
  budget** (raisable up to 60 s).

**Other hosts:**

| Host | Hook surface | Notes |
|---|---|---|
| OpenAI Codex CLI | `hooks.json`. Event names mirror Claude Code's (SessionStart, UserPromptSubmit, Pre/PostToolUse, PreCompact, Stop…) | GA reported 14 May 2026. Event count disputed (10–12), and only command handlers execute **[unverified]** |
| Gemini CLI | hooks on by default from v0.26.0. SessionStart/End, Before/AfterAgent, Before/AfterModel, Before/AfterTool, Notification | **Synchronous**: Gemini waits for hooks, so capture must be append-only and fast. Event list **[unverified]** |
| Cursor | `.cursor/hooks.json` (project, user, enterprise): `beforeShellExecution`/`afterShellExecution`, `beforeReadFile`, **`afterFileEdit`**, `beforeSubmitPrompt`, `preCompact`, `stop` | Hooks don't load in cloud agents |
| GitHub Copilot coding agent | `.github/hooks/*.json`: sessionStart/End, userPromptSubmitted, pre/postToolUse, errorOccurred; `command` and `http` types | Coding-agent sessions only. Schema shape differs between mirrors **[unverified]** |
| Kiro | `.kiro/hooks/`: File Save (`PostFileSave`), Prompt Submit, Agent Stop, Pre/Post Tool Use | |
| VS Code (any agent, or none) | extension API: `onDidSaveTextDocument`, git extension API, `vscode.lm.registerMcpServerDefinitionProvider` (preview), `registerTool`, chat participants | Cursor has its own MCP registration API instead |
| Any repo | git `post-commit` hook | Universal floor |

**Prior art for capture and distillation:**
- **claude-mem**: hooks on SessionStart, UserPromptSubmit, PostToolUse, Stop, and
  SessionEnd. These feed a long-running Express worker on port 37777 that compresses
  observations with the Agent SDK. Storage is SQLite with FTS5, plus Chroma vectors. Up
  to 10 recent sessions are injected at SessionStart. Progressive retrieval goes index →
  timeline → details.
  - **Lesson:** capture and distillation must be decoupled.
  - **Anti-lesson for us:** a port-bound daemon and a vector store are both surfaces we
    don't need.
- **Entire CLI**: hooks for git and for agents (Claude Code, Gemini CLI, OpenCode,
  Cursor, Factory Droid, Copilot CLI). It records prompts, inspected files, tool calls,
  and intermediate attempts as **Checkpoints linked to commits**, stored on a separate
  `entire/checkpoints/v1` branch. On the Thoughtworks Radar, April 2026.
  - **A ready-made multi-host capture layer we can *read* instead of rebuilding.**
- **Agent Trace** (Cursor, `0.1.0-draft`, January 2026; Radar "Assess"): a JSON spec that
  attributes file, hunk, or line ranges to the conversations and contributors (human, AI,
  or mixed) behind them, with storage left to implementers.
  - **An input adapter target, and a way to say "AI-assisted" honestly.**
- **Mastra Observational Memory**: an **Observer** agent compresses messages into dated
  observations as the conversation runs, and a **Reflector** periodically merges and
  prunes them. Both are triggered by token thresholds. Vendor-reported compression is
  6–40×.
  - **The right shape for our warm and cold paths.**
- **LangChain ambient agents**: event-stream agents with three human-in-the-loop modes,
  **notify / question / review**, surfaced through an "agent inbox."
  - **The right UX contract for an observer that must never break flow.**

**MCP spec 2026-07-28 (official blog):**
- The core is now stateless: no `initialize` handshake and no session ID.
- **Sampling, Roots, and Logging are deprecated.**
- Server-initiated `sampling/elicitation/roots` requests are replaced by multi-round-trip
  `input_required` results.
- Change notifications move to an opt-in `subscriptions/listen` stream.
- Tasks become the `io.modelcontextprotocol/tasks` extension.
- **Implication:** don't build the observer on MCP push or sampling. Hooks and a local
  journal are the capture path. MCP is the *query and review* surface.

### 3.3 Architecture: three speeds

```
 host hooks (CC · Codex · Gemini · Cursor · Copilot · Kiro) ──┐
 git post-commit (universal floor) ───────────────────────────┤
 VS Code extension (optional) ────────────────────────────────┤
 Entire checkpoints / Agent Trace / transcript backfill ──────┘
                │
   HOT  ▼  capture: normalize → redact → append       (no LLM · <50 ms p95 · never blocks host)
        ~/.skill-forge/journal/<session>.jsonl  (+ transcript byte-offset watermarks)
                │
        boundary detectors (deterministic, run at capture time)
                │  milestone?
   WARM ▼  Observer pass (detached worker, cheap model, debounced, per-session lock)
        → Observation[] {kind, claims, evidence refs, confidence}
                │
   COLD ▼  Reflector (detached spawn at SessionEnd · catch-up at SessionStart · `reflect` · schedule)
        → Story ledger (story_id, versions)  → SessionSummary projection → existing translators
                │
        Inbox: notify · question · review  →  connectors (local · return_only · notion · gist)
```

**Hot path (capture).**
- `skill-forge observe --host <h>` reads the hook payload, maps it to a normalized
  `ObservedEvent`, redacts it, and appends one JSONL line. There is no LLM call and no
  heavy import: the capture entrypoint must not load the Anthropic or OpenAI SDKs.
- **In Claude Code, the transcript may already be the journal [verify].** If it is, the
  hot path records boundaries plus **byte offsets into `transcript_path`**, and payloads
  only for what the transcript lacks (test exit codes, structural-diff stats).
  - This only works if the transcript JSONL is append-only and keeps the entries from
    before compaction. Neither is confirmed.
  - If either fails, journal the payloads as for other hosts. The `PreCompact` snapshot
    is the backstop either way.
- For hosts without a transcript (git, Cursor, Kiro), the journal carries the payloads.
- Avoid `npx` per event, since its cold resolve costs seconds. Call the installed bin
  directly.
- In Claude Code, consider an **`mcp_tool` hook** that calls an `observe_event` tool on
  the already-running `skill-forge-mcp`, with no process spawn per event. Verify its
  blocking semantics first: `async` applies only to `command` hooks.

**Boundary detectors (deterministic):**

| Signal | Detected from | Story kind |
|---|---|---|
| Test command fails ≥N times, then passes | Bash tool exit codes | **debugging arc** |
| Edit then revert, file created then deleted, `git checkout --`/`restore`, abandoned branch | file/tool events + git | **dead end** |
| New dependency added (manifest diff) | `FileChanged`/edits on package manifests | technology adoption |
| Decision language in a user prompt ("instead of", "why not", "let's go with", "tradeoff") | `UserPromptSubmit` regex | **tradeoff candidate** |
| Structural diff exceeds a threshold (Pillar A) | at `Stop`/commit | milestone |
| `git commit` | PostToolUse(Bash) or post-commit | checkpoint |
| **`PreCompact`** | hook | **mandatory snapshot**: context is about to be lost |
| `Stop` after ≥K tool calls since the last observation | hook | flush |

**Warm path (Observer).**
- At a milestone, a detached worker (`spawn` with `detached: true, windowsHide: true`,
  plus a lockfile per session) reads the journal and transcript slice since the last
  watermark. It emits typed `Observation`s via Zod.
- Observations are claim-sized, cite event IDs, SHAs, and `code_facts`, and carry a
  confidence.
- The model comes from `observer_model`, which defaults to the configured provider's
  cheap tier. Confidential repos force a local model (Ollama).
- Debounced, and capped per hour.

**Cold path (Reflector).**
- `SessionEnd` has only a 1.5 s budget. That is enough to **spawn a detached reflection
  worker** and return immediately; a spawn fits in the budget, and an LLM call doesn't.
- If the watermark shows a reflection never finished (crash, shutdown), the **next
  `SessionStart` catches up**. It does this from an `async: true` command hook that only
  spawns the worker, so session start is never delayed.
- Reflection also runs on demand (`skill-forge reflect`) or on a schedule (the v2 Bet 5
  digest).
- It merges observations into stories, dedupes across sessions, and projects each story
  into a `SessionSummary`. Existing translators then render it unchanged.
- **Living artifacts:** only stories whose evidence changed are regenerated. Each one is
  versioned and diffed. `index.yml` upserts by `story_id`.

**Interaction contract (ambient-agent patterns):**
- **Notify (default):** a one-line `systemMessage` or statusline, e.g. "2 story
  candidates captured."
- **Question (opt-in, at most 1 per session):** only for a high-value, low-confidence
  item, e.g. "You switched from polling to webhooks. What drove that?" Delivered via a
  `Stop` hook or `asyncRewake`. Answered in a single line.
- **Review:** an inbox through `skill-forge inbox`, MCP tools (`list_story_candidates`,
  `approve_story`, `discard_story`), and `/skill-forge review`. Nothing is published
  without approval.

**Backfill (fixes the cold start):** `skill-forge backfill --since 30d` runs the observer
over existing transcripts (`~/.claude/projects/*/*.jsonl`), Entire checkpoints, or git
history. Users get value on day one instead of after a month of observing. It is opt-in
and respects the same allowlist.

### 3.4 Privacy, consent, safety (non-negotiable)
- **Opt-in per repo.** Use `skill-forge observe enable`, or a user-level allowlist. A
  **confidential mode** for employer code abstracts proprietary names in artifacts and
  forces a local observer model.
- **Redaction at capture, before persistence.**
  - Patterns: cloud keys, GitHub/npm tokens, private keys, JWTs, `.env` contents,
    connection strings.
  - `tool_response` is size-capped.
  - The redaction suite is a CI test corpus.
- **Retention:** a TTL on the raw journal (default 30 days). Observations and stories
  persist. `skill-forge forget --session|--repo`.
- **Hooks never hurt the host:** async where supported, always exit 0, hard timeouts, and
  a no-op if skill-forge is misconfigured.

### 3.5 "Globally adaptable": the host-adapter layer

```ts
interface HostAdapter {
  name: "claude-code" | "codex" | "gemini-cli" | "cursor" | "copilot" | "kiro" | "vscode" | "git";
  detect(): Promise<boolean>;                     // is this host installed/configured here?
  install(scope: "user" | "project"): Promise<void>; // writes the host's hook config
  normalize(raw: unknown): ObservedEvent[];        // host payload → normalized events
}
```

- `skill-forge observe install` auto-detects hosts and writes their configs, the way
  `githits init` detects coding tools.
- Each adapter has **contract tests against recorded payload fixtures**, because hook
  schemas drift (Claude Code is at 33 events, and Codex's count is still disputed).

| Host | Distribution unit |
|---|---|
| Claude Code | **plugin** bundling the skill, slash commands, async hooks, and the MCP server |
| Codex CLI / Gemini CLI | skill + MCP + hooks config (Gemini: extension) |
| Cursor / Copilot / Kiro | MCP + hooks config |
| VS Code | extension (v3 stretch or v4): save and git events, MCP registration, `@skill-forge` chat participant |
| Everything else | git `post-commit` + CLI |

### 3.6 Risks
- **Noise:** too many low-value candidates. Track precision, and tune thresholds on the
  replay corpus.
- **Concurrency:** parallel sessions and subagents (`agent_id`). Use per-session
  journals, lockfiles, and watermarks.
- **Transcript lag and compaction:** read with tolerance. A `PreCompact` snapshot is the
  backstop.
- **Cost creep:** zero LLM calls on the hot path, a cap on the warm path, and the cold
  path only on demand or on schedule.

### 3.7 Exit criteria
- **Replay eval:** recorded journals for the fixture sessions are run through the
  observer. Measure recall of the gold dead ends and tradeoffs, compared with a
  single end-of-session pass on the compacted transcript. The target is to beat the
  baseline.
- Capture p95 < 50 ms.
- Zero secrets survive the redaction corpus.
- Observer cost per active hour stays under the configured cap.

---

## 4. Pillar C: OSS discovery subagents. Build third.

### 4.1 Research: the discovery landscape

| Provider | What it is | Access | Notes |
|---|---|---|---|
| **GitHits** | Version-aware index of OSS code, docs, and packages (GitHub, GitLab, Codeberg, npm/PyPI/crates/Go/Maven…). Deterministic code, docs, and package tools, plus agentic **`example`** (grounded in how OSS solves a problem) and experimental **`research`** (cited answers). | MCP (`npx -y githits@latest init` auto-configures 12+ tools), CLI, REST (`/v1/searches`, `/v1/code/diff`…), bearer tokens | Ranks by relevance plus activity, adoption, maintenance, and license. **Excludes copyleft and unlicensed repos by default.** On-demand indexing takes tens of seconds to minutes. Beta: "tool names … may change." Pricing not public. CLI Apache-2.0 **[unverified]** |
| **grep.app** (Vercel) | Regex code search over ~1M public GitHub repos | Remote MCP `https://mcp.grep.app`, no auth in the examples | Filters for language, repo, and path. Results include a license field (sometimes "Unknown") |
| **DeepWiki** (Cognition) | Generated wikis and Q&A per public repo | Free remote MCP `https://mcp.deepwiki.com/mcp`, no auth. Tools: `read_wiki_structure`, `read_wiki_contents`, `ask_question` | Private repos need the authenticated Devin MCP |
| **Sourcegraph MCP** | Code search plus code navigation on an instance | Instance MCP with OAuth. From 2026-03-30, `/.api/mcp` is curated, and `/.api/mcp/all` adds `deepsearch`, `go_to_definition`, `find_references` | Mainly enterprise |
| **GitHub** | Official MCP server (`search_repositories`…) and REST search | PAT | **Code search: 9 req/min.** Other search: 30/min. At most 1,000 results per query. Qualifiers include `stars:`, `topics:`, `license:`, `pushed:`, `label:"good first issue"` |
| Context7 | Version-accurate library *docs* | MCP | Docs, not code |
| Health signals | OpenSSF Scorecard (0–10 per check, API and BigQuery for 1M+ projects), deps.dev **[unverified API]**, ecosyste.ms, Software Heritage (provenance) | | For ranking which repos are worth citing |

**Gap found:** no public API matches open issues to a developer's *demonstrated* skills.
Existing tools filter by declared language or topic only. skill-forge's story ledger is
exactly the missing input.

**Security research (2025–2026):**
- Repository content is an instruction channel. Weaponized `.cursorrules`, `CLAUDE.md`,
  and copilot-instructions files reached 84–85% command execution in testing (CSA,
  2026) **[vendor-reported]**.
- MCP tool-description poisoning is real (Invariant Labs, 2025; arXiv 2603.21642, 2026
  **[preprint]**). It is on the OWASP MCP Top 10.
- The 2025 GitHub-MCP incident went from a public issue to a private-repo leak.
- **Discovery reads untrusted content by definition**, so it has to be designed for that
  from the start.

### 4.2 Four scouts and their career value

1. **Prior-art scout.**
   - Input: the story plus its fingerprint (Pillar A).
   - Finds 2–4 mature OSS implementations of the same problem and produces a comparison
     (e.g. "Envoy and Kong use GCRA; you used a token bucket because…").
   - Feeds the follow-ups in `technical-deep-dive` and `interview-qa`: *"An interviewer
     may ask why you didn't do it the way Envoy does."*
2. **Calibration scout.**
   - Is the approach standard, a known variant, or unusual? What are the canonical names
     for the patterns used?
   - This aligns vocabulary for ATS and JD matching, and grounds `calibration_note` in
     evidence instead of vibes.
3. **Contribution scout.**
   - Finds skill-matched OSS issues, using the languages and libraries the ledger *shows*
     the user has used.
   - Ranks by repo health (Scorecard, recent activity, issue responsiveness) and labels
     (`good first issue`, `help wanted`), and drops stale or assigned issues.
   - Output is a "next career move" list, never auto-filed.
4. **Gap scout** (pairs with v2 Bet 4, JD tailoring).
   - Example: the JD wants Kafka and the ledger shows none.
   - Returns the nearest adjacent evidence the user *does* have, plus 2–3 exemplar repos
     or docs to study.

### 4.3 Design
- **Where it lives:** in the existing orchestrator. Each scout is a `SubagentSpec` with a
  discovery tool set and a new **`discovery` budget tier** (roughly 6–10 tool calls and a
  60–90 s deadline). This is not a new subsystem. Opt-in with `--prior-art`, or config
  `discovery: off | host | direct`.
- **Provider abstraction:** `CodeSearchProvider { search, read, repoInfo }`.
  - `host`: emits nothing itself. SKILL.md instructs the *host* agent to call whatever
    grep.app, DeepWiki, GitHits, or Sourcegraph MCP servers it already has, and to pass
    the results into `evidence[]`.
  - `grep_app` and `deepwiki`: no-auth and read-only.
  - `github`: the user's token, behind a rate limiter.
  - `githits`: optional, using the user's own GitHits account.
- **Reconciling with `plan_ahead.md`:** it says *"No skill-forge-as-MCP-client."* That
  rule was about holding *other servers' credentials* and per-target maintenance.
  Recommendation:
  - Keep it as the default (`host` mode).
  - **Narrowly amend** it for `direct` mode, limited to no-credential, read-only, public
    endpoints (grep.app, DeepWiki), plus GitHub REST with a user-supplied token
    (skill-forge already holds a Gist token).
  - `@modelcontextprotocol/sdk` is already a dependency, and the 2026-07-28 stateless
    spec makes a per-call HTTP client trivial.
  - → *This is your decision; see §8.*
- **Untrusted-content quarantine (dual-LLM pattern):**
  - Raw OSS content is seen only by a **quarantined summarizer** that has no tools. It
    returns a constrained schema: `{repo, ref_sha, path, license, approach_summary ≤300
    chars}`.
  - The privileged scout and translators never see raw external text.
  - Strip hidden Unicode, cap bytes, and give discovery **no write or exec tools**.
  - Never auto-register MCP servers or instruction files found in fetched repos.
- **License and attribution:**
  - Never paste external code into artifacts. Paraphrase and link with the SHA.
  - Mirror GitHits' default: no quoting from copyleft or unlicensed sources.
  - Record the license in the evidence.
- **Caching and rate limits:**
  - `~/.skill-forge/cache/discovery/<hash>.json`, with a 7-day TTL.
  - A token bucket for GitHub code search (9/min).
  - A budget tier caps total calls.

### 4.4 Non-goals
- No public-code index or crawler of our own. GitHits, grep.app, and Sourcegraph exist.
- No code generation from examples. GitHits' `example` serves *coding*; we only
  *compare*.
- No opening issues, PRs, or comments on the user's behalf.

### 4.5 Risks
- **Vendor churn** (GitHits is in beta). Keep it optional behind the provider interface,
  with contract tests.
- **Prompt injection and tool poisoning.** Covered by the quarantine above, plus an
  endpoint allowlist, plus a red-team fixture: a repo whose README contains injected
  instructions.
- **Hallucinated comparisons.** Judge rule: every comparative claim must cite an evidence
  ID, and uncited ones fail the eval.

### 4.6 Exit criteria
- On the fixture bank, the prior-art scout returns ≥2 cited comparisons with known
  licenses per story.
- The judge's **groundedness** score improves, with zero uncited comparative claims.
- The red-team fixture produces no tool misuse and no injected text in artifacts.

---

## 5. Cross-cutting: data model v2 (the real v3 change)

```ts
// Sketch — names indicative, not final.
ObservedEvent  { id, host, session_id, agent_id?, ts, kind:
                 "prompt"|"tool_call"|"tool_result"|"file_edit"|"test_run"|"commit"|"compaction"|"session_end",
                 payload?, transcript_ref?: {path, offset, length}, redacted: true }

Evidence       { id, kind: "event"|"commit"|"code_fact"|"prior_art"|"calibration"|"contribution"|"gap",
                 source: { provider, url?, repo?, sha?, path?, symbol?, license?, retrieved_at },
                 summary, approximate?: boolean, confidence }

Observation    { id, session_id, kind: "tradeoff"|"dead_end"|"debug_arc"|"decision"|"milestone"|"learning",
                 claim, evidence_ids[], confidence, ts }

Story          { story_id, title, observation_ids[], evidence_ids[], code_facts?, status:
                 "candidate"|"approved"|"discarded", version, updated_at }

// SessionSummary (v1 shape, + schema_version) = projection(Story) → existing translators unchanged.
```

- `index.yml` moves from append-only to **upsert by `story_id`**. Artifact frontmatter
  gains `story_id`, `version`, and `evidence_ids`.
- **Migration:** each existing artifact becomes a story with one version. The
  `LEGACY_*` read-fallback pattern from `src/config/paths.ts` is the precedent.
- **Storage:** JSONL plus YAML plus markdown. This **reaffirms** "no vector store." If
  search is ever needed, grep the markdown. SQLite comes in only if measured scale
  demands it.

## 6. Cross-cutting: runtime, budgets, evaluation

- **Runtime:** the scout's tool count grows from 4 to about 15. Implement provider-native
  tool calling in the reserved `claude-sdk`/`openai-agents` slots of `factory.ts`, and
  keep `runToolLoop`'s JSON envelope as the floor for Ollama and other providers without
  tool calling. Don't use MCP sampling for host-delegated LLM calls, since it is
  deprecated in 2026-07-28.
- **Budget tiers:** resolve the `low: max_tool_calls 0` contradiction by adding named
  tiers (`evidence`, `discovery`). Callers choose a tier explicitly, never implicitly.
- **Evaluation (Bet 6 lands first):**
  - Judge rubric:
    - STAR completeness
    - specificity
    - **groundedness** (claim ↔ evidence)
    - **metric honesty** (numbers only from `code_facts`)
    - calibration fit
  - Plus:
    - a **replay harness** for the observer (recorded journals as fixtures)
    - **red-team fixtures** for injection
    - cost and latency budgets checked in CI

## 7. If "global" also means international users

Resume and CV conventions differ by market: US resume, UK/EU CV, Europass, Germany's
Lebenslauf, Japan's 履歴書/職務経歴書. A `locale`/`market` config with per-locale prompt
variants (the `manifest.yaml` versioning already supports variants), plus an output
language, would make the *artifacts* global and not only the hosts. I haven't researched
this deeply. It needs its own pass before planning.

---

## 8. Sequenced v3 roadmap

| Phase | Ships | Exit criterion | Size |
|---|---|---|---|
| **3.0 Foundations** | Bet 6 judge (with groundedness and metric-honesty dims); data model v2 + `index.yml` upsert + migration; **fix the commit hook** (current schema, `async`, no `npx`); named budget tiers; native tool-use runtime for Anthropic and OpenAI | Judge prints comparable scores; legacy artifacts load as stories; hook verified live in Claude Code | M |
| **3.1 Code intelligence** | `src/codeintel/` (web-tree-sitter, 6 languages); structural digest in the ingestor; `code_facts`; six scout tools; optional package | §2.6 | M |
| **3.2 Observer (Claude Code first)** | capture + redaction + journal + boundary detectors + Observer + Reflector + inbox + living artifacts; CC plugin packaging; `backfill` | §3.7 | L |
| **3.3 Cross-host** | `HostAdapter` for git (floor), Codex, Cursor, Gemini, Copilot, Kiro; `observe install` auto-detect; Entire and Agent Trace readers. *Stretch:* VS Code extension | Same replay eval passes on recorded payloads from ≥3 hosts | M |
| **3.4 Discovery** | `host` mode first (SKILL.md wiring + `evidence[]`), then `direct` (grep.app, DeepWiki, GitHub); prior-art + calibration scouts; quarantine; cache | §4.6 | M |
| **3.5 Compounding** | contribution + gap scouts (with v2 Bet 4 JD tailoring); scheduled Reflector digest (v2 Bet 5) | Paste a JD → tailored stories + gap list with study targets; a weekly digest is delivered via `return_only` | M |

**Single most important next step:** Phase 3.0's judge plus the data model. Every later
phase claims to "improve artifacts," and without a score and a ledger there is no way to
show it.

---

## 9. Explicitly NOT building in v3 (extends `plan_ahead.md`)

- **No coding-agent features:** no edits, refactors, or code generation. Serena, GitHits,
  and the host do that.
- **No public-code index or crawler, and no embeddings or vector DB** (reaffirmed;
  agentic search is enough for this job).
- **No bundled language servers and no LSP manager.** Use the host's, or one already on
  `PATH`.
- **No always-running port-bound daemon in v3.2.** Use detached workers plus lockfiles.
  Revisit only if measured latency demands it, since a local HTTP worker is an attack
  surface.
- **No MCP push or sampling as the capture path** (spec direction).
- **No auto-posting, auto-PRs, or auto-issues.** Review mode gates publication.
- **No observation without opt-in.**

## 10. Decisions for you

1. **Amend "no MCP client" for no-auth, read-only discovery?** *Recommend yes, narrowly:
   `host` is the default and `direct` is limited to grep.app, DeepWiki, and
   token-limited GitHub.*
2. **Code intelligence in core or as an optional package?** *Recommend an optional,
   auto-detected package, so the base `npx` install stays light.*
3. **Observer model default?** *Recommend the configured provider's cheap tier with an
   `observer_model` override. Confidential repos force local.*
4. **Daemon or detached workers?** *Recommend detached workers for v3.*
5. **VS Code extension in v3.3 or v4?** *Recommend v4, unless a non-agent editor audience
   turns out to matter.*

---

## Sources

**Discovery**
- [GitHits — homepage](https://githits.com/) · [GitHits docs](https://docs.githits.com/) · [docs index (llms.txt)](https://docs.githits.com/llms.txt) · [githits on Socket (npm mirror)](https://socket.dev/npm/package/githits/overview/0.16.1) · [Show HN: GitHits](https://hn.svelte.dev/item/46105112)
- [Vercel — grep a million GitHub repositories via MCP](https://vercel.com/blog/grep-a-million-github-repositories-via-mcp)
- [Cognition — DeepWiki MCP server](https://cognition.ai/blog/deepwiki-mcp-server) · [Devin docs — DeepWiki MCP](https://docs.devin.ai/fr/work-with-devin/deepwiki-mcp)
- [Sourcegraph MCP GA](https://sourcegraph.com/changelog/mcp-ga) · [Sourcegraph — default MCP tools change](https://sourcegraph.com/changelog/mcp-all)
- [GitHub REST — search](https://docs.github.com/en/rest/search/search) · [GitHub — searching for repositories](https://docs.github.com/en/enterprise-server@3.17/search-github/searching-on-github/searching-for-repositories)
- [OpenSSF Scorecard (README)](https://cdn.jsdelivr.net/gh/ossf/scorecard@main/README.md) · [Software Heritage graph dataset](https://docs.softwareheritage.org/devel/swh-export/graph/) · [CERN OSPO impact methodology](https://ospo.docs.cern.ch/projects/impact-study/methodology)
- [GitHub blog — browse good first issues](https://github.blog/open-source/maintainers/browse-good-first-issues-to-start-contributing-to-open-source)

**Code intelligence**
- [Aider — building a better repository map with tree-sitter](https://aider.chat/2023/10/22/repomap.html) · [RepoMapper MCP](https://mcpservers.org/servers/pdavis68/RepoMapper)
- [officechai — agentic search vs RAG (Cherny)](https://officechai.com/ai/claude-researcher-explains-how-agentic-search-performed-better-than-rag-for-code-generation/) · [smartscope — the RAG debate](https://smartscope.blog/en/ai-development/practices/rag-debate-agentic-search-code-exploration/) · [Cursor — secure codebase indexing](https://cursor.com/blog/secure-codebase-indexing) · [Engineer's Codex — how Cursor indexes](https://read.engineerscodex.com/p/how-cursor-indexes-codebases-fast)
- [web-tree-sitter README](https://app.unpkg.com/web-tree-sitter@0.26.11/files/README.md) · [web-tree-sitter vs native](https://instagit.com/Egonex-AI/Understand-Anything/difference-web-tree-sitter-wasm-native-tree-sitter-parsing/) · [@ast-grep/napi](https://www.npmjs.com/package/@ast-grep/napi)
- [claudelog — LSP tool in Claude Code](https://claudelog.com/faqs/what-is-lsp-tool-in-claude-code/) · [boostvolt/claude-code-lsps](https://www.vibeindex.ai/marketplaces/boostvolt/claude-code-lsps) · [Claude Code LSP support (JA)](https://azukiazusa.dev/blog/claude-code-lsp-support.md)
- [Serena (Greptile grepository)](https://www.greptile.com/grepository/serena) · [Serena — comparison to other agents](https://glama.ai/mcp/servers/@oraios/serena/blob/eb54e834b6da7a5e11f51c27afbcf55be92ae066/docs/01-about/040_comparison-to-other-agents.md)
- [SCIP](https://github.com/sourcegraph/scip) · [scip-cli](https://pypi.org/project/scip-cli/)
- [Refactoring-aware AST diff + benchmark (arXiv 2403.05939)](https://arxiv.org/pdf/2403.05939) · [Scalable structural code diffs (TU Delft)](https://pure.tudelft.nl/admin/files/247336739/Scalable_Structural_Code_Diffs_final.pdf) · [sem — semantic version control](https://braindetox.kr/en/posts/sem_semantic_version_control_2026.html) · [SemanticDiff vs difftastic](https://semanticdiff.com/blog/semanticdiff-vs-difftastic/)
- [lizard](https://pypi.org/project/lizard) · [rust-code-analysis](https://mozilla.github.io/rust-code-analysis/index.html) · [Arborist](https://docs.rs/arborist-metrics) · [codemetrics](https://pkg.go.dev/github.com/richardwooding/codemetrics)

**Observation / hosts**
- [Claude Code — hooks reference](https://code.claude.com/docs/en/hooks)
- [Cursor — hooks](https://cursor.com/docs/agent/hooks) · [GitButler — Cursor hooks deep dive](https://blog.gitbutler.com/cursor-hooks-deep-dive)
- [Google — Gemini CLI hooks](https://developers.googleblog.com/en/tailor-gemini-cli-to-your-workflow-with-hooks/) · [Codex CLI hooks after GA](https://codex.danielvaughan.com/2026/05/25/codex-cli-hooks-after-ga-event-model-trust-verification-production-patterns/) · [Copilot hooks (awesome-copilot)](https://www.mintlify.com/github/awesome-copilot/resources/hooks/overview) · [Kiro hooks](https://kiro.dev/docs/hooks/)
- [VS Code — MCP extension guide](https://code.visualstudio.com/api/extension-guides/mcp) · [Language Model Tool API](https://code.visualstudio.com/api/extension-guides/ai/tools) · [Chat Participant API](https://code.visualstudio.com/api/extension-guides/ai/chat)
- [claude-mem architecture](https://www.mintlify.com/thedotmack/claude-mem/architecture/overview) · [claude-mem docs](https://docs.claude-mem.ai/introduction)
- [Entire CLI docs](https://docs.entire.io/cli/overview) · [Thoughtworks Radar — Entire CLI](https://www.thoughtworks.com/radar/tools/entire-cli)
- [Agent Trace spec](https://agent-trace.dev/) · [Thoughtworks Radar — Agent Trace](https://www.thoughtworks.com/radar/platforms/agent-trace)
- [Mastra — Observational Memory](https://mastra.ai/en/docs/memory/observational-memory) · [Mastra — memory hooks](https://mastra.ai/blog/introducing-memory-hooks)
- [LangChain — introducing ambient agents](https://blog.langchain.com/introducing-ambient-agents)
- [MCP 2026-07-28 specification (official blog)](https://blog.modelcontextprotocol.io/posts/2026-07-28/) · [MCP Tasks (2025-11-25)](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/tasks) · [WorkOS — MCP 2025-11-25](https://workos.com/blog/mcp-2025-11-25-spec-update)

**Competitors / adjacent**
- [@bragdoc/cli](https://www.npmjs.com/package/@bragdoc/cli) · [bragbot](https://awesome.ecosyste.ms/projects/github.com%2Fnaamanu%2Fbragbot) · [brag-ai](https://pypi.org/project/brag-ai/) · [promoteme](https://rust-digger.code-maven.com/crates/promoteme) · [Career Harvest skill](https://mcpmarket.com/tools/skills/career-harvest) · [GitResume](https://jaydeep.is-a.dev/projects/gitresume)

**Security**
- [CSA — AI coding agent attack surface: MCP & repository poisoning](https://labs.cloudsecurityalliance.org/wp-content/uploads/2026/06/ai-coding-agent-attack-surface-mcp-repository-poisoning-v1.0-csa-styled.pdf) · [CSA — MCP tool poisoning & IDE auto-execution](https://labs.cloudsecurityalliance.org/research/csa-research-note-mcp-tool-poisoning-auto-execution-20260701/)
- [Promptfoo — MCP tool-metadata injection](https://www.promptfoo.dev/lm-security-db/vuln/mcp-tool-metadata-prompt-injection-in-coding-agents-5f9a8525) · [Promptfoo — untrusted skills/MCP content](https://www.promptfoo.dev/lm-security-db/vuln/untrusted-skills-and-mcp-content-cross-coding-agent-trust-boundaries-cc2a2b4a/) · [devclass — GitHub MCP prompt injection](https://devclass.com/2025/05/27/researchers-warn-of-prompt-injection-vulnerability-in-github-mcp-with-no-obvious-fix/)
