import { ChangeClassification, EntityChange } from "../types/code-facts.js";
import { ChangedFile } from "./git.js";
import { isConfigPath, isDocPath, isTestPath } from "./paths.js";

/**
 * Feature / refactor / fix / test / config / docs — decided from structure,
 * not guessed from the diff text. A refactor story and a feature story are
 * told differently, so the label feeds framing downstream. Every decision
 * carries its reasons so the call is auditable.
 *
 * Rules, in order:
 *   1. Only docs / only tests / only config changed → that label.
 *   2. Commit subjects say fix/bug/regression… and at most one entity was
 *      added → fix.
 *   3. No entities added, and something was renamed/moved or touched
 *      complexity went down → refactor.
 *   4. Any entity added → feature.
 *   5. Edits only: removed ≥ added lines → refactor; otherwise mixed.
 */
const FIX_WORDS = /\b(fix(e[sd])?|bug(fix)?|hotfix|patch(ed)?|regression|crash(es)?|broken|issue)\b/i;

export function classifyChange(input: {
  files: ChangedFile[];
  changes: EntityChange[];
  subjects: string[];
  complexity?: { touched_before: number; touched_after: number };
}): { classification: ChangeClassification; reasons: string[] } {
  const { files, changes, subjects } = input;
  if (files.length === 0) return { classification: "mixed", reasons: ["no analyzable files changed"] };

  const all = (pred: (p: string) => boolean) => files.every((f) => pred(f.path));
  if (all(isDocPath)) return { classification: "docs", reasons: ["only documentation files changed"] };
  if (all(isTestPath)) return { classification: "test", reasons: ["only test files changed"] };
  if (all(isConfigPath)) return { classification: "config", reasons: ["only configuration/build files changed"] };

  const sourceChanges = changes.filter((c) => !isTestPath(c.path));
  const count = (kind: EntityChange["change"]) => sourceChanges.filter((c) => c.change === kind).length;
  const added = count("added");
  const restructured = count("renamed") + count("moved");

  const fixSubject = subjects.find((s) => FIX_WORDS.test(s));
  if (fixSubject && added <= 1) {
    return { classification: "fix", reasons: [`commit subject reads as a fix: "${fixSubject.slice(0, 80)}"`] };
  }

  const cx = input.complexity;
  const simpler = cx !== undefined && cx.touched_after < cx.touched_before;
  if (added === 0 && (restructured > 0 || simpler)) {
    const reasons = ["no new entities"];
    if (restructured > 0) reasons.push(`${restructured} entit${restructured === 1 ? "y" : "ies"} renamed or moved`);
    if (simpler) reasons.push(`touched complexity fell ${cx!.touched_before} → ${cx!.touched_after}`);
    return { classification: "refactor", reasons };
  }

  if (added > 0) {
    const exported = sourceChanges.filter((c) => c.change === "added" && c.exported).length;
    return {
      classification: "feature",
      reasons: [`${added} entit${added === 1 ? "y" : "ies"} added${exported ? ` (${exported} exported)` : ""}`],
    };
  }

  const linesAdded = files.reduce((n, f) => n + f.lines_added, 0);
  const linesRemoved = files.reduce((n, f) => n + f.lines_removed, 0);
  if (linesRemoved >= linesAdded && linesAdded + linesRemoved > 0) {
    return { classification: "refactor", reasons: ["edits only, net lines removed"] };
  }
  return { classification: "mixed", reasons: ["edits to existing code without a clearer signal"] };
}
