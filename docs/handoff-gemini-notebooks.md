# Handoff — "Gemini Notebooks connector" → shipped as host-delivery (`return_only`)

*Date: 2026-09-18. Branch: `phase0-and-quality-fixes`. Author: pairing session.*

This is a beginner-friendly walkthrough of what you asked for, what we actually built and
why it's different (on purpose), how to try it, and what's left.

---

## 1. What you asked for vs. what we built

**You asked:** "Introduce a new connector to Gemini Notebooks (NotebookLM, rebranded)."

**What we built:** a **host-delivery output mode** called `return_only` — *not* a
hand-written Gemini Notebooks connector. This was a deliberate pivot, and it's the more
correct answer. Here's the reasoning chain, because the *why* matters more than the code:

1. **Your own roadmap forbids the obvious version.** `plan_ahead.md` records two decisions:
   *"No skill-forge-as-MCP-client holding other servers' credentials"* and *"Default is
   host-delivery; hand-write a connector only where the host can't deliver."* A
   `NotebookConnector` class would break both.

2. **So we ran the plan's own "reality check" first** (you picked this option). We checked
   whether NotebookLM can even be reached, and how:
   - **No official public write API** exists for consumer NotebookLM/Gemini Notebook — only
     an Enterprise *preview* API. Every other write path is **undocumented browser
     automation** (driving Chrome with your Google cookies). Fragile: cookies expire every
     2–4 weeks, and one of the popular community servers was *already archived* (Sept 2026).
     Building that into skill-forge would mean skill-forge holding your Google session — the
     exact anti-pattern the plan rejects.
   - **But mature NotebookLM MCP servers already exist** (`jacob-bd/notebooklm-mcp-cli`,
     `PleasePrompto/notebooklm-mcp`) and expose an `add_source` / `source_add` tool that
     accepts **raw text/markdown paste** (`type=text`). That's exactly what skill-forge
     produces.

3. **Conclusion:** the right design is the one the plan predicted (Bet 2). skill-forge
   renders the artifact and *returns it*; the **host** (which has the NotebookLM MCP
   connected) delivers it via `add_source(type=text)`. skill-forge holds zero credentials,
   and the *same* mode also delivers to Slack, LinkedIn, and Google Docs for free.

**Plain-English analogy:** instead of skill-forge learning to drive to every post office
itself (and keeping keys to all of them), it writes the letter and hands it to the assistant
who's already standing at the counter with the right account.

---

## 2. What changed in the code (small + surgical)

| File | Change |
|---|---|
| `src/output/connectors/factory.ts` | Registered a `return_only` connector that **reuses `LocalFileConnector`** (no new class — the plan said "a mode, not a connector class"). It still writes to your local corpus so `index.yml` stays intact. |
| `src/output/return-only.ts` (new) | The `RETURN_ONLY` constant + `formatReturnOnly()` — builds the host-facing message: local path + a destination-agnostic "deliver this" instruction + the **fully rendered** markdown (frontmatter *and* body). |
| `src/mcp/server.ts` | `generate_career_artifact` now branches: if `connector === "return_only"`, it returns the host-delivery block instead of "Written to: …". Added `connector` to the tool's input schema description. |
| `src/index.ts` | The CLI `generate` command branches the same way for `--connector return_only`. |
| `docs/mcp-server.md` | Documented the new mode. |
| `tests/output/return-only.test.ts` (new) | 3 tests: it's a registered connector, it embeds the full render, and the instruction is destination-agnostic. |

**Why the behavior lives in the "tool layer" and not in a connector class:** the connector
interface (`CareerModeConnector.write`) is contractually only allowed to return a *location
string* (a path or URL), not content. Returning the *rendered artifact* to the caller is a
different shape, so it has to live in the code that calls the connector (the MCP tool and the
CLI). A connector class would have been a byte-for-byte duplicate of `LocalFileConnector` —
the advisor caught this and we removed it from the design before writing it.

---

## 3. How to try it

**CLI:**
```bash
skill-forge generate --mode portfolio-bullet --connector return_only
```
You'll see the artifact saved to your local corpus path, then the full rendered markdown with
a "Deliver this artifact…" instruction printed to stdout.

**MCP (inside a host like Claude Code that also has a NotebookLM MCP connected):**
Ask the host to "generate a portfolio bullet and add it to my NotebookLM notebook." The host
calls `generate_career_artifact` with `connector: "return_only"`, gets the markdown back, and
then calls the NotebookLM MCP's `add_source(type=text)` with it.

**Tests:** `npm test` (74 passing, including the 3 new ones).

---

## 4. Retrospection — what went well / what to watch

**Went well:**
- Verifying *before* building saved us from shipping a fragile, plan-violating connector.
- Reusing `LocalFileConnector` kept the diff tiny and the corpus/index behavior identical.

**Went well (added 2026-09-18, dogfood):**
- **End-to-end round-trip verified against a real NotebookLM MCP.** Using
  `notebooklm-mcp-cli` (v0.11.5): `generate --connector return_only` → `nlm notebook create`
  → `nlm source add <id> --text "$(cat <corpus artifact>)" --wait`. The source ingested
  (`status: 2`, `type: generated_text`) and a grounded `nlm notebook query` answered while
  **citing our artifact verbatim**. The `--text` flag is exactly the `add_source(type=text)`
  path the design targeted. Notebook: `b793d536-7b23-4171-90fe-2ad17cac6708`.

**Watch out for:**
- **The delivery instruction is a prompt, not an enforced contract.** A host *might* ignore
  it. That's inherent to host-delivery; it's the trade-off for holding no credentials.
- **Mode choice affects grounding depth.** The dogfood used `portfolio-bullet` (terse
  bullets); a grounded query for the *why* behind the design got a thin answer because that
  rationale isn't in short bullets. For a notebook meant to answer "why" questions, prefer
  `technical-deep-dive` or `interview-qa` — the round-trip is identical, the content is richer.

---

## 5. Suggested next steps (in order)

1. ~~**End-to-end smoke with a real NotebookLM MCP**~~ — **DONE 2026-09-18** (see
   Retrospection above). Round-trip verified with a grounded, cited query.
2. **Consider making `return_only` the documented default for "share to X" flows** in the
   README, alongside the existing Notion/Gist connectors.
3. **Bet 6 (LLM-as-judge)** is the next small, high-value plan item if you want to keep
   moving down the roadmap.

> Note: Phase 0 naming (`career-mode` → `skill-forge`) is still partially in flight — you'll
> still see `career-mode` in some strings/tool names (e.g. `notion_auth_status` help text,
> MCP tool names). That's tracked separately in the plan (P0.1) and is unrelated to this
> change.
