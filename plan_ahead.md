# skill-forge — Plan Ahead (2026)

> How to make skill-forge relevant to where the ecosystem is going: distribute it as a
> portable Agent Skill, compose the connector ecosystem instead of rebuilding it, and
> lean on the one thing this repo has that most tools don't — a budgeted, sandboxed,
> tool-using orchestrator.

*Author: forward-looking plan. Supersedes the historical `plan/technical-plan.md` and
`plan/career-mode-prd.md` as the roadmap of record. Date: 2026-09-07.*

---

## TL;DR

skill-forge already has the hard part built: a **typed capture pipeline** (`ingestor →
SessionSummary → translators → connectors`) exposed over four surfaces, a provider
abstraction, a self-registering connector registry, a versioned-prompt eval harness, and
— most differentiated — a budgeted, sandboxed, tool-using **focus scout**
(`src/orchestrator/`). What's missing is not more engine. It's **reach and focus**.

The bets, ruthlessly ordered for a one-maintainer v0.1:

| # | Bet | Why now | Effort |
|---|-----|---------|--------|
| **0** | **Fix naming + prove the install paths** | The quickstart is broken; distribution can't start on top of it | S |
| **1** | **Ship as a portable Agent Skill (SKILL.md)** | Skills are a cross-platform open standard as of Dec 2025 | M |
| **2** | **Host-delivery connector (`return_only`)** | Zero-credential output to Notion/Slack/LinkedIn the host already has | S |
| **3** | **Grow the scout into an evidence engine** | Turns PR/ticket history into stories — one lever, not a new subsystem | M |
| **4** | **JD tailoring mode** | The single biggest real need in this space | M |
| **5** | **Scheduled weekly career digest** | Rides the scheduled-agents / routines trend | S |
| **6** | **LLM-as-judge on the eval harness** | Makes prompt quality measurable, not vibes | S |

**Single most important next step:** Bet 0. Nothing else ships cleanly until the name is
one name and `npm install -g` → run actually works.

---

## Where skill-forge stands today (honest read)

**Strengths worth protecting — this is the moat:**

- **Typed contract.** `SessionSummarySchema` (`src/types/session.ts`) is the seam that
  makes translators swappable and lets a prompt change without a code change. This is the
  thing a plain SKILL.md cannot give you.
- **Connector registry + factory.** `src/output/connectors/registry.ts` +
  `factory.ts` self-register connectors and always co-write local via `CompoundConnector`.
  Adding a destination is a registration, not a rewrite.
- **The orchestrator/scout.** `src/orchestrator/` is the most advanced code in the repo:
  budget tiers (`BUDGETS` in `focus.ts`), a sandboxed tool set with path-escape guards and
  result caps (`subagent/tools/registry.ts`: `grep`/`read_file`/`list_files`/`git_log`),
  a runtime seam already stubbed for `claude-sdk` / `openai-agents`
  (`subagent/factory.ts`), and graceful degradation (never throws; falls back to plain-text
  focus). It is wired to exactly **one** narrow use — the interview-qa focus lens.
- **Eval harness + prompt versioning.** `scripts/prompt-eval.ts` + `manifest.yaml` +
  versioned `.txt` prompts already exist. Rare for a v0.1.
- **Provider abstraction.** Anthropic / OpenAI-compatible (DeepSeek, Groq, Together,
  Ollama, …) with env auto-detect. Runs local-first.

**The split that blocks everything downstream:**

- The package/binaries are `skill-forge` / `skill-forge-mcp` (`package.json`), and the CLI
  registers `program.name("skill-forge")` (`src/index.ts:22`) — **but** the README
  quickstart, the CLI's own help output (`src/index.ts:114,175`), the config dir
  (`~/.career-mode/`, referenced across 12 source files), the config filename, the
  `CAREER_MODE_PROMPT_VERSION` env var, the slash command, and the MCP tool names
  (`generate_career_artifact`, `notion_auth_status`) are all `career-mode`.
- Net effect: the README tells users to `npm install -g @abhinavravich1999/skill-forge`
  and then run `career-mode auth notion` — **a binary that does not exist.** The tool's own
  success message points at the same dead command.
- The README's marquee section ("Couldn't you just write a skill for this?", lines 15–24)
  is both **unfinished** (the promised list after "a different category of thing:" is
  empty) and **now wrong** — see the repositioning below.

---

## The 2026 landscape (why this plan, why now)

- **Agent Skills are a real open standard.** The Agent Skills spec was published at
  agentskills.io (Dec 18 2025) and is stewarded through the Agentic AI Foundation. By Q2
  2026 the ecosystem went from one registry to eight major marketplaces, with ~40
  skills-compatible products on the official showcase — **OpenAI Codex, GitHub Copilot,
  Cursor, Gemini CLI, VS Code** among them. A SKILL.md skill is no longer a Claude-Code
  slash command; it is a **cross-host distribution unit** that bundles instructions **plus
  scripts**.
- **MCP is the interop layer, not a feature.** Hosts increasingly ship with connectors
  (Notion, Slack, GitHub, Google Drive, Linear, …) already authorized in the user's
  session. Anything skill-forge ships as its *own* integration competes with that instead
  of composing it.
- **Scheduled / recurring agents ("routines") went mainstream.** A tool that produces
  something worth producing *on a cadence* (a weekly brag doc) fits the moment.
- **Eval-driven prompt development is table stakes** for anything selling "quality
  output." skill-forge has the harness; it needs a score.

**Implication:** the leverage is no longer in the pipeline. It's in **distribution
(Skills), composition (host connectors), and depth (the scout).**

---

## Guiding principles

1. **The Skill is the interface; the typed pipeline + eval harness + orchestrator are the
   engine.** This is the repositioning. The old README claim ("this is *not* a skill")
   made sense before Skills could bundle scripts. Now the honest, *stronger* claim is:
   *anyone can write a prompt that says "summarize my session"; skill-forge is the engine
   that makes the output typed, calibrated, evaluated, and routable.* The plan should make
   the two documents stop arguing.
2. **Compose the ecosystem; don't rebuild it.** Every credential skill-forge holds is a
   liability it maintains. Prefer host-delivered output and host-connected sources over
   hand-written API clients.
3. **Capture where the work actually happened.** The richest career stories live in PRs,
   closed tickets, and postmortems — not only in the live transcript.
4. **Spend depth on the one differentiator.** The orchestrator is the moat. Widen it
   before adding breadth elsewhere.

---

## Phase 0 — Prerequisites (must land before distribution)

Distribution amplifies whatever you ship. Ship coherence first.

- **P0.1 — One name.** Decide `skill-forge` (matches npm + bin, recommended) and make it
  total: README, all CLI help/console strings, config dir (`~/.skill-forge/` with a
  one-release read-fallback to `~/.career-mode/`), config filename,
  `SKILL_FORGE_PROMPT_VERSION` (alias the old env for one release), slash command name, and
  the MCP tool names. Grep the 12 `~/.career-mode` sites + the `CAREER_MODE_*` sites as the
  worklist.
- **P0.2 — Prove the packaged binaries.** The README Status section lists
  `npm link` / `npx skill-forge-mcp` as **untested**. The entire SKILL.md thesis (Bet 1)
  depends on the bundled CLI running from a clean global install in a host env you don't
  control. Add a CI job that `npm pack`s, installs the tarball into a temp dir, and runs
  `skill-forge --help` + a stubbed `generate` on Node 20/22, Ubuntu/Windows.
- **P0.3 — Prove the git-hook path.** Also listed untested. It's the zero-friction on-ramp;
  a broken on-ramp is worse than none.

**Exit criterion:** a fresh machine can `npm i -g @…/skill-forge`, run every command the
README prints, and get an artifact. One name appears everywhere.

---

## The initiatives (ordered)

### Bet 1 — Ship as a portable Agent Skill

**What:** A proper `SKILL.md` package (progressive disclosure: short front-matter
description, body that defers to bundled scripts) that wraps the existing CLI/MCP surface,
publishable to the Skills directory and the community marketplaces. The slash command
becomes *one* rendering of the Skill, not a bespoke artifact.

**Why it's the headline bet:** it's the "skill forger" identity, it's the
don't-reinvent-the-wheel move (adopt the standard instead of a custom `.md` command), and
it's the only bet that multiplies reach across Codex / Cursor / Copilot / Gemini CLI /
VS Code.

**The underestimated part is not the markdown — it's the dependency story** in a host you
don't control:
- Node presence and version, `@…/skill-forge` availability (bundle vs `npx`).
- API-key discovery and a *graceful unconfigured state* (detect no provider → print the
  one-liner setup, don't crash).
- Config discovery when `cwd` and `$HOME` aren't what you expect.
- Deterministic behavior when the git context is empty (hook path).

Treat P0.2/P0.3 as the real content of this bet.

### Bet 2 — Host-delivery connector (`return_only`) — the connector strategy

**What:** A first-class output mode where `generate_career_artifact` writes locally **and
returns the rendered artifact to the caller**, so the *host* delivers it using connectors
the user has already authorized (Notion, Slack, Google Docs, LinkedIn, …). This is a mode
on the existing tool + a documented pattern, **not** a new connector class and **not**
skill-forge acting as an MCP client of other servers.

**Why this over more hand-written connectors:** zero credentials to hold, zero per-target
maintenance, and it gets strictly *better* every time a host adds a connector — without a
skill-forge release. It is the sharpest expression of principle #2.

**Decision recorded:** we are **not** building skill-forge-as-MCP-client (holding other
servers' launch commands + secrets and running client sessions). That's a second
integration surface per target with none of the upside. Host-delivery is the default;
hand-written connectors survive only where the host demonstrably can't deliver
(see table).

> **Amended in v3 (plan_v3.md §10, decision 1):** a narrow exception for *discovery*
> only. Host mode stays the default. Direct mode may talk to public, read-only,
> no-credential MCP endpoints (grep.app, DeepWiki) and the GitHub REST API (with an
> optional user token), behind a hard endpoint allowlist. It holds no other server's
> credentials and never launches local MCP servers. See `src/discovery/`.

### Bet 3 — Grow the scout into an evidence engine (unifies input-side ecosystems)

**What:** The scout in `src/orchestrator/` already reads the repo under budget. Widen its
tool set and its callers so it can *gather the raw material of career stories* from where
work happens:
- New sandboxed tools in `subagent/tools/registry.ts`: `git_show` / diff-by-SHA, PR/MR
  history, closed-ticket lookups.
- Pull ticket/PR context from **host-connected MCP servers** (Linear, Jira, GitHub) rather
  than bespoke API clients — same don't-reinvent principle as Bet 2, input side.
- Call the scout from `portfolio-bullet` and the (new) digest path, not just interview-qa
  focus.

**Why it's one lever, not three:** "pull evidence from PRs/tickets" *is* the scout with
more tools and more callers. Framing it as a subsystem inflates the plan and hides that the
budget/sandbox/runtime seam is already built. This is where depth spend goes.

### Bet 4 — JD tailoring mode (the biggest real "use-needing" feature)

**What:** Accept a job description (paste or file); tailor the artifact bank to it —
reweight which stories surface, align vocabulary, flag gaps ("this JD wants Kafka; your
artifacts show none"). Reuses the FocusBrief machinery (`category_weights`,
`gaps_to_probe`) almost verbatim — a JD is just a richer focus lens.

**Why:** interview/resume tailoring against a specific role is the highest-frequency real
need in this category, and skill-forge is unusually well-positioned because it already has
a *typed corpus* of a user's real work to tailor from. This is the feature that makes
someone open the tool the night before an interview.

### Bet 5 — Scheduled weekly career digest

**What:** A scheduled run (routine / cron) that fires weekly, invokes the scout over the
week's commits + closed PRs/tickets (Bet 3), and produces a brag-doc digest delivered via
host-delivery (Bet 2). Ships only after 2 and 3 exist — it's their composition, cheap once
they land.

**Why:** the "brag doc dies because nobody writes it" problem is a *cadence* problem, and
scheduled agents are exactly the 2026 primitive for it.

### Bet 6 — LLM-as-judge on the eval harness

**What:** Add a scoring pass to `scripts/prompt-eval.ts`: a rubric-driven judge
(STAR completeness, specificity, calibration fit) that emits comparable scores per
fixture × mode × version, so "promote v2?" is a number, not a vibe. Cheap, and it protects
every prompt change from here on.

---

## Connector priority (where artifacts want to go, and how)

Default is **host-delivery (Bet 2)**. Hand-write a connector only where the host can't
deliver *and* the destination is high-value.

| Destination | Real need | Strategy | Priority |
|---|---|---|---|
| Notion | brag doc / living portfolio | keep existing (already built & tested) | ✅ have it |
| Gist | quick shareable link | keep existing | ✅ have it |
| Local / Obsidian | private vault, markdown-native | keep local; Obsidian needs no code (it's `.md`) | ✅ have it |
| Slack `#wins` | team-visible impact | **host-delivery** | high |
| LinkedIn draft | portfolio-bullet's natural home | **host-delivery** (no bespoke OAuth) | high |
| Google Docs / Confluence | performance-review packet | **host-delivery** | medium |
| GitHub profile README / PR body | dev-audience portfolio | thin connector *if* host can't (reuse gist auth) | medium |
| Dev.to / Hashnode (blog) | technical-deep-dive's home | **host-delivery**; bespoke only if demand is real | low |

The point of the table: **almost everything new is host-delivery.** The hand-written
connector list barely grows.

---

## What we are explicitly NOT building

Half of "use-needing features rather than reinventing the wheel" is naming the wheels.

- **No resume-builder UI / PDF layout engine.** That market is saturated; skill-forge's
  value is the *content*, not the typesetting. Emit clean markdown; let existing tools
  render.
- **No web app / hosted SaaS dashboard.** It's a local-first CLI + Skill + MCP server.
  A dashboard is a different product with a different maintenance burden.
- **No bespoke OAuth per destination.** Where a host already authorizes Slack / LinkedIn /
  Google, use host-delivery. Building our own auth for those re-implements what the
  ecosystem solved.
- **No skill-forge-as-MCP-client** holding other servers' credentials and sessions (see
  Bet 2 rationale; v3 allows only allowlisted, read-only, no-credential discovery endpoints).
- **No new "mode" for every artifact shape.** interview-qa / portfolio-bullet /
  technical-deep-dive cover the space; JD-tailoring and digest are *lenses/schedules* over
  them, not new translators.
- **No proprietary vector store / "memory" layer.** The `index.yml` + typed artifacts are
  the corpus; if search is ever needed, index the markdown, don't build a database.

---

## Sequenced roadmap

| Phase | Ships | Exit criterion |
|---|---|---|
| **0 — Coherence** | P0.1 one name; P0.2 packaged-binary CI; P0.3 hook proof | Fresh `npm i -g` → every README command works; one name everywhere |
| **1 — Distribution** | Bet 1 SKILL.md + graceful unconfigured state | Skill installs and runs from a non-Claude-Code host (e.g. Codex/Cursor) |
| **2 — Composition** | Bet 2 `return_only` mode + docs; Bet 6 judge | Artifact delivered to Slack via host with zero skill-forge credentials; eval prints scores |
| **3 — Depth** | Bet 3 scout evidence tools + `portfolio-bullet` caller | `generate` produces a bullet grounded in a real PR diff it fetched itself |
| **4 — Need + cadence** | Bet 4 JD tailoring; Bet 5 scheduled digest | Paste a JD → tailored bank + gap list; a scheduled run delivers a weekly digest |

Phases 0–2 are the ones that change skill-forge's *relevance*. 3–4 are the ones that make
it *loved*. Don't reorder: distribution on a broken quickstart wastes the launch.

---

## Risks & open questions

- **Host-delivery reality check (blocks Bet 2 planning):** confirm the target hosts
  actually expose their connectors to a Skill/MCP tool's *returned content* in a way the
  host will then act on. If a given host won't, that destination falls back to a
  hand-written connector — verify before committing the phase.
- **SKILL.md dependency portability:** the bundled-CLI-in-an-unknown-host problem (Bet 1)
  is the likeliest thing to eat time. De-risk with P0.2 first.
- **Scout cost creep:** more tools + more callers = more tokens. The budget tiers exist;
  keep `portfolio-bullet`/digest on `low` by default and make `medium` opt-in.
- **Naming migration pain:** config-dir rename needs the one-release read-fallback so
  existing users' `~/.career-mode/` artifacts aren't orphaned.
- **Provider drift:** pin and periodically refresh model IDs; the README already shows a
  stale one (`claude-sonnet-4-6`). Keep model defaults in one place.

---

## Sources

- [The Agent Skills Ecosystem in 2026 — Agentman](https://agentman.ai/blog/agent-skills-ecosystem-report-2026)
- [AI Agent Marketplaces 2026: Discovery and Distribution — DigitalApplied](https://www.digitalapplied.com/blog/ai-agent-marketplaces-2026-discovery-distribution)
- [7 AI Agent Skills Marketplaces in 2026 — Agensi](https://www.agensi.io/learn/best-ai-agent-skills-marketplaces-2026)
- [Agent Skills Marketplace in 2026: Anthropic vs Vercel vs OpenAI vs Cline vs MCP — Totalum](https://www.totalum.app/blog/agent-skills-marketplaces-2026)
