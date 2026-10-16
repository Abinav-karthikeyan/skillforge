import { EntityKind } from "../types/code-facts.js";

/**
 * Structural types for the slice of web-tree-sitter that core uses. Core never
 * imports web-tree-sitter itself — the runtime arrives from the optional
 * companion package — so these interfaces are the contract.
 */
export interface TSPoint {
  row: number;
  column: number;
}

export interface TSNode {
  readonly type: string;
  readonly text: string;
  readonly startIndex: number;
  readonly endIndex: number;
  readonly startPosition: TSPoint;
  readonly endPosition: TSPoint;
  readonly parent: TSNode | null;
  readonly children: TSNode[];
  readonly namedChildren: TSNode[];
  readonly isNamed: boolean;
  readonly hasError: boolean;
  childForFieldName(name: string): TSNode | null;
}

export interface TSTree {
  readonly rootNode: TSNode;
  delete(): void;
}

// Opaque handle from the runtime; only passed back into it.
export type TSLanguage = object;

export interface TSParser {
  setLanguage(language: TSLanguage | null): unknown;
  parse(source: string): TSTree | null;
  delete(): void;
}

export interface CodeIntelRuntime {
  version: string;
  grammars: string[];
  grammarPath(id: string): string | null;
  createParser(): TSParser;
  loadLanguage(path: string): Promise<TSLanguage>;
}

/** A named code entity found in one file. */
export interface Definition {
  name: string;
  /** Container-qualified name, e.g. `RateLimiter.allow`. */
  qualified: string;
  kind: EntityKind;
  start_line: number;
  end_line: number;
  signature: string;
  /** Hash of the whitespace-normalized text with the declared name masked — equal across a pure rename. */
  body_hash: string;
  /** Token multiset fingerprint for fuzzy rename matching. */
  tokens: string[];
  exported: boolean;
  complexity: number;
}

export interface FileEntities {
  language: string;
  definitions: Definition[];
  /** Referenced names (calls, constructions, type uses), with duplicates. */
  references: string[];
  imports: string[];
  parse_error: boolean;
}
