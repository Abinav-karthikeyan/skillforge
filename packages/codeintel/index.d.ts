import type { Language, Parser, Query } from "web-tree-sitter";

export type GrammarId = "typescript" | "tsx" | "javascript" | "python" | "go" | "java" | "rust" | "csharp";

export declare const GRAMMARS: Readonly<Record<GrammarId, string>>;
export declare const VERSION: string;

export declare function grammarPath(id: string): string | null;

export interface CodeIntelRuntime {
  version: string;
  grammars: GrammarId[];
  grammarPath(id: string): string | null;
  createParser(): Parser;
  loadLanguage(path: string): Promise<Language>;
  createQuery(language: Language, source: string): Query;
}

export declare function loadRuntime(): Promise<CodeIntelRuntime>;
