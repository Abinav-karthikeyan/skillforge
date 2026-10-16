/**
 * Untrusted-content hygiene (plan_v3 §4.3 quarantine). Repository text is an
 * instruction channel — weaponized READMEs and rules files reached 84–85%
 * command execution in 2026 testing — so everything external is sanitized
 * before the quarantined summarizer sees it, and everything the summarizer
 * returns is validated before the privileged pipeline sees it.
 */

// Zero-width, bidi overrides/isolates, BOM, soft hyphen, tag characters, and C0/C1 controls (except \n \t).
const HIDDEN = /[​-‏‪-‮⁠-⁤⁦-⁩﻿­]|[\u{E0000}-\u{E007F}]|[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/gu;

export function stripHidden(text: string): string {
  return text.replace(HIDDEN, "");
}

export function stripHtml(text: string): string {
  return text
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(lt|gt|amp|quot|#39|nbsp);/g, (m) => ({ "&lt;": "<", "&gt;": ">", "&amp;": "&", "&quot;": '"', "&#39;": "'", "&nbsp;": " " })[m] ?? m);
}

/** Prepare untrusted text for the quarantined summarizer. */
export function sanitizeUntrusted(text: string, maxChars = 8_000): string {
  const clean = stripHidden(stripHtml(text)).replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  return clean.length > maxChars ? clean.slice(0, maxChars) + "\n[…truncated]" : clean;
}

/**
 * Markers of an injection attempt surviving into a summary: imperatives aimed
 * at a model, tool/exec instructions, exfiltration, or role tags. A summary
 * carrying any of these is dropped, never repaired.
 */
const INJECTION = [
  /\b(ignore|disregard|forget|override)\b.{0,40}\b(previous|prior|above|all|any|earlier|system)\b.{0,20}\b(instructions?|prompts?|rules?|messages?)\b/i,
  /\b(system|developer)\s+(prompt|message|instructions?)\b/i,
  /\byou (must|should|are required to|have to)\b/i,
  /\b(run|execute|invoke|call)\b.{0,30}\b(command|shell|script|tool|curl|wget|bash|powershell)\b/i,
  /\b(curl|wget|iwr|invoke-webrequest)\s+\S+/i,
  /\brm\s+-rf\b|\bsudo\b|\bchmod\s+\+x\b/i,
  /\b(api[_ -]?key|token|password|secret|credential)s?\b.{0,30}\b(send|post|upload|exfiltrat|leak|share)/i,
  /\b(register|add|install)\b.{0,30}\b(mcp|server|hook|plugin|extension)\b/i,
  /<\/?(system|assistant|user|tool|instructions?)>/i,
  /\b(HACKED|PWNED|jailbreak)\b/i,
  /```/,
];

export function looksInjected(text: string): boolean {
  return INJECTION.some((re) => re.test(text));
}

/** Remove URLs from model-written text; provenance links come only from structured fields. */
export function stripUrls(text: string): string {
  return text.replace(/\bhttps?:\/\/\S+/gi, "").replace(/\s{2,}/g, " ").trim();
}
