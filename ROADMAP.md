# Career Mode — Roadmap

Post-P0 work. P0 (MCP server + three-interface framing) shipped in commit `d19ccd3`.
Priority is roughly ordered by credibility-per-effort for the CV project framing.
Edit freely — this is your working doc, not a spec.

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

## P2 — Demo GIF in the README

**Why.** For a developer tool, "watch it work in 20 seconds" beats any amount of prose. The README currently has zero visual proof.

**Steps.**
- Record a short session (~30s max). Two candidate flows:
  1. `/career-mode` in Claude Code, showing the artifact being written and its contents.
  2. Claude Code calling the MCP tool inline ("generate a portfolio bullet"), showing the tool call + response.
- Recording tool: [asciinema](https://asciinema.org/) (crisp, small, GitHub embeds) or a real GIF via ScreenToGif / LICEcap. Prefer asciinema for terminal-only; GIF if you want to show Claude Code's UI.
- Embed at the top of the README, above "The problem" section.
- If asciinema: publish + embed the SVG player. If GIF: keep it under ~2 MB.

**Done when.** The README opens with a moving image of the tool doing its job. Test the render in incognito on the GitHub page.

**Notes.**
- 

---

## P3 — Ship one non-local connector (GitHub Gist)

**Why.** The `CareerModeConnector` interface exists but only `LocalFileConnector` implements it. A second connector proves the interface actually extends (not just theoretically) and gives users a reason to share artifacts. Gist is the cheapest — no OAuth, just a personal access token.

**Steps.**
- New file `src/output/connectors/gist.ts` implementing `CareerModeConnector`. Uses `fetch` against `https://api.github.com/gists` with a token from `GITHUB_TOKEN` env or config.
- Add `connector: local | gist` to `CalibrationConfig`. Default stays `local`.
- Wire selection in `src/index.ts` and `src/mcp/server.ts` (single factory function, don't duplicate the switch).
- Add a new MCP tool `share_last_artifact` — reads the most recent artifact from `index.yml` and pushes it to Gist. This is the "one-click share" that makes the connector visible to users.
- Update `docs/mcp-server.md` with the new tool.

**Done when.** `career-mode generate --connector gist` returns a real gist URL. In an MCP host, asking Claude to "share the last artifact" produces a working URL.

**Notes.**
- 

---

## P4 — Real test suite + CI

**Why.** Right now correctness rests on one smoke script. For a project framed as engineering-craft, having zero tests is the second thing a reviewer notices missing (after the missing demo). This also protects you from regressions as you iterate.

**Steps.**
- Pick a runner. Vitest is the low-friction choice (native TS/ESM, no config drama).
- Unit tests worth writing first:
  - `ingestSession` — fence-stripping (`stripFences`), schema validation on malformed input, session_id/timestamp filling.
  - `renderMarkdown` — frontmatter shape stable across modes.
  - Each translator's `interpolate` — placeholders replaced, missing keys don't crash.
  - `LocalFileConnector.write` — filename slug, `index.yml` append idempotency.
- Add one integration test that spawns the MCP server (reuse the pattern from `scripts/mcp-smoke-test.ts`) and asserts `tools/list` matches.
- CI: GitHub Actions workflow running `npm ci && npm run build && npm test && npx tsc --noEmit` on Node 20 + 22, Ubuntu + Windows. Add a status badge to the README.

**Done when.** `npm test` passes locally; a green CI badge sits at the top of the README next to the npm version badge.

**Notes.**
- 

---

## P4.5 — Prompt versioning + eval baseline

**Why.** The core thesis ("structured beats naive prompting") is architectural until the prompts are demonstrably good. Right now prompts are three flat `.txt` files with no way to iterate, roll back, A/B, or trace which prompt produced a given artifact. Fix that before P5 so dogfooding actually generates signal.

**Design (baseline — not the full thing).**

```
src/prompts/
  manifest.yaml                      # declares active version per mode
  interview-qa/v1.txt, v2.txt, v3.txt
  portfolio-bullet/v1.txt, v2.txt
  technical-deepdive/v1.txt
```

`manifest.yaml`:
```yaml
interview-qa:
  active: v3
  versions:
    v3: { notes: "STAR enforcement + tighter calibration", tuned_against: claude-sonnet-4-6 }
    v2: { notes: "First iteration, over-verbose" }
```

**Steps.**
- Migrate current `src/prompts/*.txt` → `src/prompts/<mode>/v1.txt`. Write `manifest.yaml` with `active: v1` for each.
- `loadPrompt(name)` reads manifest, returns active version's content. Override precedence: CLI flag `--prompt-version <v>` > env `CAREER_MODE_PROMPT_VERSION` > manifest.
- `renderMarkdown` writes `prompt_version: interview-qa@v3` into artifact frontmatter. Now every artifact is traceable to a prompt.
- Grow the fixture bank: add ~4 more session fixtures covering different shapes (debugging-heavy, greenfield feature, refactor, ML/data). Currently there's one.
- New `scripts/prompt-eval.ts`: takes fixtures × versions × modes, runs each, writes outputs to `test-output/eval/<timestamp>/<mode>-<version>/<fixture>.md` for side-by-side manual review.

**What's explicitly out of scope for the baseline.** Automated quality scoring (LLM-as-judge or heuristic rubric). Worth adding only after you have 2–3 versions and want regression signal. Adding it before that is over-engineering.

**Honest caveat.** An eval harness answers "did I regress?" — not "is this useful in a real interview?" The two questions need two loops: eval catches regressions, P5 dogfooding proves real-world value. Neither alone closes the empirical gap.

**Done when.** `career-mode generate --prompt-version v2` runs against v2 instead of active; every artifact frontmatter names its prompt version; `npx tsx scripts/prompt-eval.ts` produces a comparison folder you can diff two prompt versions in.

**Notes.**
- 

---

## P5 — Dogfood publicly (the empirical proof gap)

**Why.** The architectural story is solid but the *quality* story is unproven — nobody has run this on 10 real sessions and looked at the outputs. Until that happens, the whole thesis ("structured output beats a naive prompt") is a claim. Fixing this needs no code, just discipline.

**Steps.**
- Use `/career-mode` at the end of the next 10 real coding sessions (yours, on any project). Save all artifacts.
- After 10, read them cold. For each, ask: would I actually use this in an interview without heavy editing?
- Two possible outcomes:
  - **They're good enough.** Pick the best 2–3 artifacts, redact identifying detail, publish them in `docs/sample-artifacts/`, and link them from the README's "Sample outputs" section. This is the empirical proof.
  - **They're not good enough.** The prompts need iteration. Log which fields consistently underperform and fix those prompt files. This is 30% of the value of the whole project per the PRD, so budget real time.
- Bonus: write one blog post — "I used my own tool to prep for my last interview. Here's what worked and what didn't." This is the recursive proof-of-value.

**Done when.** The README has a "Sample outputs" section pointing at real artifacts generated from real sessions, and you have honest notes on which modes work and which don't.

**Notes.**
- 

---

## P6 (stretch) — Show HN launch

**Why.** MCP is having a moment. "I built an MCP server that turns coding sessions into interview prep" is a strong hook. Only worth doing after P1–P3 are in place (npm published, demo GIF, one non-trivial connector) — a Show HN on a rough repo is worse than no launch.

**Steps.**
- Pre-check: npm install works cold, GIF renders, MCP registration one-liner works, sample artifacts exist.
- Draft the post: what it is (one sentence), the problem (two sentences), the design choice worth talking about (three-interface architecture over one pipeline, or the schema-driven prompt design), a link to a sample artifact.
- Post 9–11am ET, weekday. Reply to every comment for the first 6 hours.
- Cross-post: r/LocalLLaMA (Ollama angle), r/ClaudeAI, Twitter/X with the GIF.

**Done when.** Post is live. Star count, issues, or forks is the signal — not upvotes.

**Notes.**
- 
