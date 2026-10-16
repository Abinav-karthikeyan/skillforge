import { extname } from "path";
import { EntityKind } from "../types/code-facts.js";
import { TSNode } from "./types.js";

/**
 * Per-language rules for the AST walker in ./entities.ts. Rules are keyed by
 * node type and read fields by name, so an unknown node type in a future
 * grammar is simply skipped — unlike a query file, which fails to compile.
 * Each language is contract-tested against fixture snippets
 * (tests/codeintel/languages.test.ts); start from those when bumping a grammar.
 */
export type LanguageId = "typescript" | "tsx" | "javascript" | "python" | "go" | "java" | "rust" | "csharp";

export interface DefRule {
  kind: EntityKind | ((node: TSNode) => EntityKind | null);
  /** Locate the name node; defaults to the `name` field. */
  name?: (node: TSNode) => TSNode | null;
}

export interface LanguageSpec {
  id: LanguageId;
  /** Grammar id in the companion package. */
  grammar: string;
  label: string;
  extensions: string[];
  defs: Record<string, DefRule>;
  /** Nodes whose name qualifies nested definitions (classes, impl blocks, namespaces). */
  containers: Record<string, (node: TSNode) => string | null>;
  /** Containers inside which a function definition is a method. */
  methodContainers: Set<string>;
  /** Cyclomatic weight per node type (usually 1; Rust match_expression is −1). */
  decisionWeights: Record<string, number>;
  /** Node types that count as a decision only when the predicate holds. */
  conditionalDecisions: Record<string, (node: TSNode) => boolean>;
  references: Record<string, (node: TSNode) => string | null>;
  imports: Record<string, (node: TSNode) => string | null>;
  /** Is this definition part of the file's public surface? */
  isExported(node: TSNode, name: string, containerExported: boolean | null): boolean;
}

// ── helpers ────────────────────────────────────────────────────────────────

const field = (name: string) => (node: TSNode) => node.childForFieldName(name);

function textOf(node: TSNode | null | undefined): string | null {
  return node ? node.text : null;
}

function unquote(s: string | null): string | null {
  return s ? s.replace(/^["'`]|["'`]$/g, "") : null;
}

/** The node itself if it matches, else its first descendant of `type` (pre-order). */
function firstDescendant(node: TSNode | null, type: string): TSNode | null {
  if (!node) return null;
  if (node.type === type) return node;
  const stack = [...node.children].reverse();
  while (stack.length) {
    const n = stack.pop()!;
    if (n.type === type) return n;
    for (let i = n.children.length - 1; i >= 0; i--) stack.push(n.children[i]);
  }
  return null;
}

function hasChildOfType(node: TSNode, type: string, text?: RegExp): boolean {
  return node.children.some((c) => c.type === type && (!text || text.test(c.text)));
}

function hasAncestor(node: TSNode, type: string, stopAt: string[] = []): boolean {
  for (let p = node.parent; p; p = p.parent) {
    if (p.type === type) return true;
    if (stopAt.includes(p.type)) return false;
  }
  return false;
}

/** The operator token of a binary expression (field `operator`, or the middle child). */
function operatorOf(node: TSNode): string {
  const op = node.childForFieldName("operator");
  if (op) return op.text;
  return node.children.find((c) => !c.isNamed)?.text ?? "";
}

const LOGICAL = new Set(["&&", "||", "??", "and", "or"]);
const isLogical = (node: TSNode) => LOGICAL.has(operatorOf(node));

/** Name of a called function: `foo()` → foo, `a.b.foo()` → foo. */
function calleeName(fn: TSNode | null): string | null {
  if (!fn) return null;
  switch (fn.type) {
    case "identifier":
    case "field_identifier":
    case "property_identifier":
    case "type_identifier":
      return fn.text;
    case "member_expression":
      return textOf(fn.childForFieldName("property"));
    case "attribute":
      return textOf(fn.childForFieldName("attribute"));
    case "selector_expression":
      return textOf(fn.childForFieldName("field"));
    case "field_expression":
      return textOf(fn.childForFieldName("field"));
    case "scoped_identifier":
      return textOf(fn.childForFieldName("name"));
    case "member_access_expression":
      return textOf(fn.childForFieldName("name"));
    case "generic_function":
      return calleeName(fn.childForFieldName("function"));
    case "generic_name":
      return textOf(firstDescendant(fn, "identifier")) ?? fn.text;
    default:
      return null;
  }
}

// ── TypeScript / JavaScript ────────────────────────────────────────────────

const JS_FUNCTION_VALUES = new Set([
  "arrow_function",
  "function_expression",
  "function",
  "generator_function",
]);

function jsLikeExported(node: TSNode, name: string, containerExported: boolean | null): boolean {
  const isMember = node.type === "method_definition" || node.type === "public_field_definition";
  // A function declared inside a function body is local, whatever its container.
  if (!isMember && hasAncestor(node, "statement_block", ["class_body"])) return false;
  if (containerExported !== null) {
    return containerExported && !name.startsWith("#") && !hasChildOfType(node, "accessibility_modifier", /private|protected/);
  }
  return hasAncestor(node, "export_statement", ["statement_block", "class_body"]);
}

function jsSpec(id: "typescript" | "tsx" | "javascript"): LanguageSpec {
  const isTs = id !== "javascript";
  const defs: Record<string, DefRule> = {
    function_declaration: { kind: "function" },
    generator_function_declaration: { kind: "function" },
    method_definition: { kind: "method" },
    class_declaration: { kind: "class" },
    variable_declarator: {
      kind: (n) => (JS_FUNCTION_VALUES.has(n.childForFieldName("value")?.type ?? "") ? "function" : null),
    },
    public_field_definition: {
      kind: (n) => (JS_FUNCTION_VALUES.has(n.childForFieldName("value")?.type ?? "") ? "method" : null),
    },
  };
  if (isTs) {
    Object.assign(defs, {
      abstract_class_declaration: { kind: "class" },
      interface_declaration: { kind: "interface" },
      type_alias_declaration: { kind: "type" },
      enum_declaration: { kind: "enum" },
    });
  }
  const references: LanguageSpec["references"] = {
    call_expression: (n) => calleeName(n.childForFieldName("function")),
    new_expression: (n) => calleeName(n.childForFieldName("constructor")),
  };
  if (isTs) references.type_identifier = (n) => n.text;

  return {
    id,
    grammar: id,
    label: id === "javascript" ? "JavaScript" : id === "tsx" ? "TSX" : "TypeScript",
    extensions:
      id === "javascript" ? [".js", ".mjs", ".cjs", ".jsx"] : id === "tsx" ? [".tsx"] : [".ts", ".mts", ".cts"],
    defs,
    containers: {
      class_declaration: (n) => textOf(n.childForFieldName("name")),
      abstract_class_declaration: (n) => textOf(n.childForFieldName("name")),
      internal_module: (n) => textOf(n.childForFieldName("name")),
    },
    methodContainers: new Set(["class_declaration", "abstract_class_declaration"]),
    decisionWeights: {
      if_statement: 1,
      for_statement: 1,
      for_in_statement: 1,
      while_statement: 1,
      do_statement: 1,
      switch_case: 1,
      catch_clause: 1,
      ternary_expression: 1,
    },
    conditionalDecisions: { binary_expression: isLogical },
    references,
    imports: {
      import_statement: (n) => unquote(textOf(n.childForFieldName("source"))),
    },
    isExported: jsLikeExported,
  };
}

// ── Python ─────────────────────────────────────────────────────────────────

const python: LanguageSpec = {
  id: "python",
  grammar: "python",
  label: "Python",
  extensions: [".py", ".pyi"],
  defs: {
    function_definition: { kind: "function" },
    class_definition: { kind: "class" },
  },
  containers: { class_definition: (n) => textOf(n.childForFieldName("name")) },
  methodContainers: new Set(["class_definition"]),
  decisionWeights: {
    if_statement: 1,
    elif_clause: 1,
    for_statement: 1,
    while_statement: 1,
    except_clause: 1,
    conditional_expression: 1,
    boolean_operator: 1,
    for_in_clause: 1,
    if_clause: 1,
    case_clause: 1,
  },
  conditionalDecisions: {},
  references: {
    call: (n) => calleeName(n.childForFieldName("function")),
  },
  imports: {
    import_statement: (n) => textOf(n.childForFieldName("name")),
    import_from_statement: (n) => textOf(n.childForFieldName("module_name")),
  },
  isExported: (node, name, containerExported) => {
    if (name.startsWith("_")) return false;
    // A def nested in a function body is never public.
    if (hasAncestor(node, "function_definition", ["class_definition"])) return false;
    return containerExported ?? true;
  },
};

// ── Go ─────────────────────────────────────────────────────────────────────

const go: LanguageSpec = {
  id: "go",
  grammar: "go",
  label: "Go",
  extensions: [".go"],
  defs: {
    function_declaration: { kind: "function" },
    method_declaration: { kind: "method" },
    type_spec: {
      kind: (n) => {
        const t = n.childForFieldName("type")?.type;
        return t === "struct_type" ? "struct" : t === "interface_type" ? "interface" : "type";
      },
    },
    type_alias: { kind: "type" },
  },
  containers: {
    // Methods are qualified by their receiver type: (s *Server) Start → Server.Start
    method_declaration: () => null,
  },
  methodContainers: new Set(),
  decisionWeights: {
    if_statement: 1,
    for_statement: 1,
    expression_case: 1,
    type_case: 1,
    communication_case: 1,
  },
  conditionalDecisions: { binary_expression: isLogical },
  references: {
    call_expression: (n) => calleeName(n.childForFieldName("function")),
    composite_literal: (n) => textOf(firstDescendant(n.childForFieldName("type") ?? n, "type_identifier")),
  },
  imports: {
    import_spec: (n) => unquote(textOf(n.childForFieldName("path"))),
  },
  isExported: (_node, name) => /^[A-Z]/.test(name),
};

/** Go receiver type for qualification. */
export function goReceiverType(method: TSNode): string | null {
  return textOf(firstDescendant(method.childForFieldName("receiver"), "type_identifier"));
}

// ── Java ───────────────────────────────────────────────────────────────────

const javaName = (n: TSNode) => textOf(n.childForFieldName("name"));

const java: LanguageSpec = {
  id: "java",
  grammar: "java",
  label: "Java",
  extensions: [".java"],
  defs: {
    class_declaration: { kind: "class" },
    record_declaration: { kind: "class" },
    interface_declaration: { kind: "interface" },
    enum_declaration: { kind: "enum" },
    method_declaration: { kind: "method" },
    constructor_declaration: { kind: "method" },
  },
  containers: {
    class_declaration: javaName,
    record_declaration: javaName,
    interface_declaration: javaName,
    enum_declaration: javaName,
  },
  methodContainers: new Set(["class_declaration", "record_declaration", "interface_declaration", "enum_declaration"]),
  decisionWeights: {
    if_statement: 1,
    for_statement: 1,
    enhanced_for_statement: 1,
    while_statement: 1,
    do_statement: 1,
    catch_clause: 1,
    ternary_expression: 1,
  },
  conditionalDecisions: {
    binary_expression: isLogical,
    switch_label: (n) => !/^default\b/.test(n.text),
  },
  references: {
    method_invocation: (n) => textOf(n.childForFieldName("name")),
    object_creation_expression: (n) =>
      textOf(firstDescendant(n.childForFieldName("type") ?? n, "type_identifier")) ??
      textOf(n.childForFieldName("type")),
    type_identifier: (n) => n.text,
  },
  imports: {
    import_declaration: (n) => n.text.replace(/^import\s+(static\s+)?/, "").replace(/;\s*$/, "").trim(),
  },
  isExported: (node, _name, containerExported) => {
    const modifiers = node.children.find((c) => c.type === "modifiers");
    if (modifiers && /\bpublic\b/.test(modifiers.text)) return containerExported !== false;
    // Interface members are implicitly public.
    return containerExported === true && node.parent?.parent?.type === "interface_declaration";
  },
};

// ── Rust ───────────────────────────────────────────────────────────────────

const rust: LanguageSpec = {
  id: "rust",
  grammar: "rust",
  label: "Rust",
  extensions: [".rs"],
  defs: {
    function_item: { kind: "function" },
    struct_item: { kind: "struct" },
    union_item: { kind: "struct" },
    enum_item: { kind: "enum" },
    trait_item: { kind: "trait" },
    type_item: { kind: "type" },
  },
  containers: {
    impl_item: (n) => textOf(firstDescendant(n.childForFieldName("type") ?? n, "type_identifier")) ?? textOf(n.childForFieldName("type")),
    trait_item: (n) => textOf(n.childForFieldName("name")),
    mod_item: (n) => textOf(n.childForFieldName("name")),
  },
  methodContainers: new Set(["impl_item", "trait_item"]),
  decisionWeights: {
    if_expression: 1,
    for_expression: 1,
    while_expression: 1,
    match_arm: 1,
    // A match with N arms adds N−1 paths.
    match_expression: -1,
  },
  conditionalDecisions: { binary_expression: isLogical },
  references: {
    call_expression: (n) => calleeName(n.childForFieldName("function")),
    struct_expression: (n) => textOf(firstDescendant(n.childForFieldName("name") ?? n, "type_identifier")) ?? textOf(n.childForFieldName("name")),
    type_identifier: (n) => n.text,
  },
  imports: {
    use_declaration: (n) => textOf(n.childForFieldName("argument")),
  },
  isExported: (node, _name, containerExported) => {
    if (hasChildOfType(node, "visibility_modifier")) return true;
    // Trait-impl methods are public through the trait.
    return containerExported === true && node.parent?.parent?.type === "impl_item" &&
      node.parent.parent.childForFieldName("trait") !== null;
  },
};

// ── C# ─────────────────────────────────────────────────────────────────────

const csName = (n: TSNode) => textOf(n.childForFieldName("name"));

const csharp: LanguageSpec = {
  id: "csharp",
  grammar: "csharp",
  label: "C#",
  extensions: [".cs"],
  defs: {
    class_declaration: { kind: "class" },
    record_declaration: { kind: "class" },
    struct_declaration: { kind: "struct" },
    interface_declaration: { kind: "interface" },
    enum_declaration: { kind: "enum" },
    method_declaration: { kind: "method" },
    constructor_declaration: { kind: "method" },
    local_function_statement: { kind: "function" },
  },
  containers: {
    class_declaration: csName,
    record_declaration: csName,
    struct_declaration: csName,
    interface_declaration: csName,
    namespace_declaration: csName,
  },
  methodContainers: new Set(["class_declaration", "record_declaration", "struct_declaration", "interface_declaration"]),
  decisionWeights: {
    if_statement: 1,
    for_statement: 1,
    foreach_statement: 1,
    while_statement: 1,
    do_statement: 1,
    catch_clause: 1,
    conditional_expression: 1,
    switch_expression_arm: 1,
  },
  conditionalDecisions: {
    binary_expression: isLogical,
    switch_section: (n) => !/^default\s*:/.test(n.text.trim()),
  },
  references: {
    invocation_expression: (n) => calleeName(n.childForFieldName("function")),
    object_creation_expression: (n) => calleeName(n.childForFieldName("type")),
  },
  imports: {
    using_directive: (n) => n.text.replace(/^(global\s+)?using\s+(static\s+)?/, "").replace(/;\s*$/, "").trim(),
  },
  isExported: (node, _name, containerExported) => {
    const isPublic = node.children.some((c) => c.type === "modifier" && c.text === "public");
    if (isPublic) return containerExported !== false;
    return containerExported === true && node.parent?.parent?.type === "interface_declaration";
  },
};

// ── registry ───────────────────────────────────────────────────────────────

export const LANGUAGES: Record<LanguageId, LanguageSpec> = {
  typescript: jsSpec("typescript"),
  tsx: jsSpec("tsx"),
  javascript: jsSpec("javascript"),
  python,
  go,
  java,
  rust,
  csharp,
};

const BY_EXTENSION = new Map<string, LanguageSpec>();
for (const spec of Object.values(LANGUAGES)) {
  for (const ext of spec.extensions) BY_EXTENSION.set(ext, spec);
}

/** Language for a path, by extension; null for unsupported files. */
export function languageForPath(path: string): LanguageSpec | null {
  if (path.endsWith(".d.ts")) return null; // declarations, not implementation
  return BY_EXTENSION.get(extname(path).toLowerCase()) ?? null;
}

/** Display label for any path, including ones without a grammar. */
export function languageLabel(path: string): string | null {
  const spec = languageForPath(path);
  if (spec) return spec.label === "TSX" ? "TypeScript" : spec.label;
  const ext = extname(path).toLowerCase();
  const OTHER: Record<string, string> = {
    ".c": "C", ".h": "C", ".cpp": "C++", ".cc": "C++", ".hpp": "C++", ".rb": "Ruby", ".php": "PHP",
    ".kt": "Kotlin", ".kts": "Kotlin", ".swift": "Swift", ".scala": "Scala", ".sh": "Shell",
    ".ps1": "PowerShell", ".sql": "SQL", ".vue": "Vue", ".svelte": "Svelte", ".dart": "Dart",
    ".ex": "Elixir", ".exs": "Elixir", ".lua": "Lua", ".zig": "Zig",
  };
  return OTHER[ext] ?? null;
}
