# @abhinavravich1999/skill-forge-codeintel

Optional code-intelligence companion for [skill-forge](https://github.com/Abinav-karthikeyan/skillforge).

Installing it next to skill-forge upgrades git-based ingestion from line counts (L0) to
**structural facts** (L1): which functions, classes, and types were added, modified,
renamed, or removed; per-function cyclomatic complexity before and after; public API
changes; tests that reference the changed symbols; an approximate blast radius; and a
ranked repo map. skill-forge uses these as the only allowed source of numbers in
artifacts, so bullets like "cut the complexity of `parseToken` from 14 to 6" are facts,
not guesses.

```bash
npm i -g @abhinavravich1999/skill-forge @abhinavravich1999/skill-forge-codeintel
skill-forge codeintel status
```

With `npx`, put both packages in one invocation:
`npx -p @abhinavravich1999/skill-forge -p @abhinavravich1999/skill-forge-codeintel skill-forge …`

## What's inside

- [`web-tree-sitter`](https://www.npmjs.com/package/web-tree-sitter) (WASM, pinned): identical
  behaviour on every OS, nothing to compile at install time.
- Vendored grammars for TypeScript, TSX, JavaScript, Python, Go, Java, Rust, and C#
  (`grammars/`). Each file is pinned to an upstream release and checksummed in
  `grammars/MANIFEST.json`. Nothing is downloaded at runtime. Upstream licenses are in
  `grammars/licenses/` (all MIT).

All analysis logic lives in skill-forge itself; this package only supplies the parser
runtime and grammars.

## Maintainers

```bash
npm run vendor-grammars   # re-vendor from the pinned upstream versions (scripts/vendor-grammars.mjs)
npm run check-grammars    # verify vendored files against MANIFEST.json (also runs on prepack)
```
