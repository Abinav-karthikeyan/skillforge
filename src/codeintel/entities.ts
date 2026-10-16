import { createHash } from "crypto";
import { goReceiverType, LanguageSpec } from "./languages.js";
import { CodeIntelRuntime, Definition, FileEntities, TSLanguage, TSNode, TSParser } from "./types.js";

/** Cyclomatic complexity of one function/method node. Nested definitions are counted separately. */
export function cyclomaticComplexity(fn: TSNode, spec: LanguageSpec): number {
  let complexity = 1;
  const stack: TSNode[] = [...fn.children];
  while (stack.length) {
    const node = stack.pop()!;
    const rule = spec.defs[node.type];
    // A nested function/method is its own unit (lizard / SonarSource convention).
    if (rule && node !== fn && isFunctionLike(node, spec)) continue;
    complexity += spec.decisionWeights[node.type] ?? 0;
    const conditional = spec.conditionalDecisions[node.type];
    if (conditional && conditional(node)) complexity += 1;
    for (const child of node.children) stack.push(child);
  }
  return Math.max(1, complexity);
}

function isFunctionLike(node: TSNode, spec: LanguageSpec): boolean {
  const rule = spec.defs[node.type];
  if (!rule) return false;
  const kind = typeof rule.kind === "function" ? rule.kind(node) : rule.kind;
  return kind === "function" || kind === "method";
}

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function bodyNode(node: TSNode): TSNode | null {
  return node.childForFieldName("body") ?? node.childForFieldName("value")?.childForFieldName("body") ?? null;
}

function signatureOf(node: TSNode): string {
  const body = bodyNode(node);
  const head = body
    ? node.text.slice(0, Math.max(0, body.startIndex - node.startIndex))
    : node.text.split(/\r?\n/)[0];
  const sig = collapse(head).replace(/[{:=]\s*$/, "").trim();
  return sig.length > 200 ? sig.slice(0, 197) + "..." : sig;
}

/**
 * Hash of the definition's text with whitespace collapsed and its own name
 * masked, so a pure rename hashes identically and formatting-only edits don't
 * register as modifications.
 */
function bodyHashOf(
  node: TSNode,
  nameNode: TSNode,
  cut: Array<[number, number]> = []
): { hash: string; tokens: string[] } {
  // Mask the declared name and drop `cut` ranges (absolute offsets), back to front.
  const edits: Array<[number, number, string]> = [
    [nameNode.startIndex, nameNode.endIndex, "§"],
    ...cut.map(([s, e]): [number, number, string] => [s, e, ""]),
  ];
  edits.sort((a, b) => b[0] - a[0]);
  let masked = node.text;
  for (const [s, e, replacement] of edits) {
    masked = masked.slice(0, s - node.startIndex) + replacement + masked.slice(e - node.startIndex);
  }
  const normalized = collapse(masked);
  const tokens = normalized.split(/[^A-Za-z0-9_§]+/).filter((t) => t.length > 1);
  return { hash: createHash("sha1").update(normalized).digest("hex"), tokens };
}

/**
 * Byte ranges of the outermost function/method definitions inside a
 * container. A class's own hash excludes them, so a class only reads as
 * "modified" when its own text changes (fields, heritage, decorators) — its
 * members are reported individually.
 */
function memberRanges(container: TSNode, spec: LanguageSpec): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const stack = [...container.children];
  while (stack.length) {
    const n = stack.pop()!;
    if (isFunctionLike(n, spec)) {
      ranges.push([n.startIndex, n.endIndex]);
      continue;
    }
    stack.push(...n.children);
  }
  return ranges;
}

interface Frame {
  node: TSNode;
  containers: string[];
  /** Node type of the innermost container, for method detection. */
  containerType: string | null;
  /** Export status of the innermost container definition, or null at top level. */
  containerExported: boolean | null;
}

/** Walk a parsed tree and extract definitions, references, and imports. */
export function extractFromTree(root: TSNode, spec: LanguageSpec): FileEntities {
  const definitions: Definition[] = [];
  const references: string[] = [];
  const imports: string[] = [];
  const defNameStarts = new Set<number>();

  const stack: Frame[] = [{ node: root, containers: [], containerType: null, containerExported: null }];
  while (stack.length) {
    const { node, containers, containerType, containerExported } = stack.pop()!;
    let nextContainers = containers;
    let nextContainerType = containerType;
    let nextContainerExported = containerExported;

    const rule = spec.defs[node.type];
    if (rule) {
      let kind = typeof rule.kind === "function" ? rule.kind(node) : rule.kind;
      const nameNode = rule.name ? rule.name(node) : node.childForFieldName("name");
      if (kind && nameNode) {
        const name = nameNode.text;
        if (kind === "function" && containerType && spec.methodContainers.has(containerType)) kind = "method";
        let qualifiers = containers;
        if (spec.id === "go" && node.type === "method_declaration") {
          const receiver = goReceiverType(node);
          if (receiver) qualifiers = [...containers, receiver];
        }
        const exported = spec.isExported(node, name, containerExported);
        const isFn = kind === "function" || kind === "method";
        const { hash, tokens } = bodyHashOf(node, nameNode, isFn ? [] : memberRanges(node, spec));
        defNameStarts.add(nameNode.startIndex);
        definitions.push({
          name,
          qualified: [...qualifiers, name].join("."),
          kind,
          start_line: node.startPosition.row + 1,
          end_line: node.endPosition.row + 1,
          signature: signatureOf(node),
          body_hash: hash,
          tokens,
          exported,
          complexity: isFn ? cyclomaticComplexity(node, spec) : 0,
        });
        if (spec.containers[node.type]) nextContainerExported = exported;
      }
    }

    const containerName = spec.containers[node.type]?.(node);
    if (containerName) {
      nextContainers = [...containers, containerName];
      nextContainerType = node.type;
      // Containers that aren't definitions themselves (Rust impl, namespaces)
      // inherit visibility from their own context.
      if (!rule) nextContainerExported = containerExported ?? true;
    }

    const ref = spec.references[node.type];
    if (ref && !defNameStarts.has(node.startIndex)) {
      const name = ref(node);
      if (name && /^[A-Za-z_$][\w$]*$/.test(name)) references.push(name);
    }
    const imp = spec.imports[node.type]?.(node);
    if (imp) imports.push(imp);

    for (let i = node.children.length - 1; i >= 0; i--) {
      stack.push({
        node: node.children[i],
        containers: nextContainers,
        containerType: nextContainerType,
        containerExported: nextContainerExported,
      });
    }
  }

  definitions.sort((a, b) => a.start_line - b.start_line);
  return { language: spec.id, definitions, references, imports, parse_error: root.hasError };
}

/**
 * Parses source files with the companion runtime. Grammars load lazily, and
 * results are cached by content hash (a Merkle-style idea without a server):
 * the same blob at two revisions, or in two files, is parsed once.
 */
export class EntityExtractor {
  private parser: TSParser | null = null;
  private languages = new Map<string, Promise<TSLanguage | null>>();
  private cache = new Map<string, FileEntities>();
  private static readonly MAX_CACHE = 2_000;

  constructor(private readonly runtime: CodeIntelRuntime) {}

  private language(spec: LanguageSpec): Promise<TSLanguage | null> {
    let pending = this.languages.get(spec.grammar);
    if (!pending) {
      const path = this.runtime.grammarPath(spec.grammar);
      pending = path ? this.runtime.loadLanguage(path).catch(() => null) : Promise.resolve(null);
      this.languages.set(spec.grammar, pending);
    }
    return pending;
  }

  /** Extract entities from source text, or null if the grammar is unavailable. */
  async extract(source: string, spec: LanguageSpec): Promise<FileEntities | null> {
    const key = createHash("sha1").update(spec.id).update("\0").update(source).digest("hex");
    const hit = this.cache.get(key);
    if (hit) return hit;

    const language = await this.language(spec);
    if (!language) return null;
    this.parser ??= this.runtime.createParser();
    this.parser.setLanguage(language);
    const tree = this.parser.parse(source);
    if (!tree) return null;
    try {
      const entities = extractFromTree(tree.rootNode, spec);
      if (this.cache.size >= EntityExtractor.MAX_CACHE) {
        this.cache.delete(this.cache.keys().next().value as string);
      }
      this.cache.set(key, entities);
      return entities;
    } finally {
      tree.delete();
    }
  }
}
