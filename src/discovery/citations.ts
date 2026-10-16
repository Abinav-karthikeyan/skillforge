import { Evidence } from "../types/evidence.js";

/**
 * Turn inline evidence citations (`[pa-envoyproxy-envoy-1a2b3c4]`) into
 * numbered footnotes with a Sources section: repo @ pinned SHA, path, license,
 * link. Provenance comes only from the structured evidence fields — never from
 * model-written text. A no-op for artifacts that cite nothing.
 */
const CITABLE = new Set(["prior_art", "calibration"]);

export function renderCitations(content: string, evidence: Evidence[]): string {
  const byId = new Map(evidence.filter((e) => CITABLE.has(e.kind)).map((e) => [e.id, e]));
  if (byId.size === 0) return content;
  const order: string[] = [];
  const replaced = content.replace(/\[((?:pa|cal)-[a-z0-9-]+)\]/g, (m, id: string) => {
    if (!byId.has(id)) return "";
    if (!order.includes(id)) order.push(id);
    return `[${order.indexOf(id) + 1}]`;
  });
  if (order.length === 0) return replaced;
  const lines = order.map((id, i) => {
    const e = byId.get(id)!;
    const s = e.source;
    if (e.kind === "calibration") return `[${i + 1}] skill-forge calibration against the prior art above`;
    const where = [s.repo && s.sha ? `${s.repo} @ ${s.sha.slice(0, 7)}` : s.repo, s.path, s.license].filter(Boolean).join(" · ");
    return `[${i + 1}] ${where}${s.url ? ` — ${s.url}` : ""}`;
  });
  return `${replaced.trimEnd()}\n\n---\n\n**Sources**\n\n${lines.join("  \n")}\n`;
}
