import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { relative } from "node:path";
import { Language, Parser } from "web-tree-sitter";
import type { GraphEdge, GraphNode, GraphStore, NodeKind } from "./types.ts";

/**
 * Symbol indexer built on `web-tree-sitter` (SPEC §4.2).
 *
 * WASM rather than native bindings: grammar packages ship prebuilt `.wasm`, so
 * indexing needs no compiler. That keeps the no-native-dependency property from
 * ADR-001, which is what lets the project build on any platform.
 *
 * What is extracted is decided by what §4.3 has to answer without opening a
 * file: a signature, a first doc line, and the call and import edges that make
 * "who calls this" and "what breaks if I change this" answerable.
 */

const require = createRequire(import.meta.url);

/** Content hash for incremental indexing (ADR-003). */
export const hashContent = (content: string): string =>
  createHash("blake2b512").update(content, "utf8").digest("hex").slice(0, 32);

export interface LanguageSpec {
  readonly id: string;
  /** Extensions this grammar claims, without the dot. */
  readonly extensions: readonly string[];
  /** Resolvable path to the grammar's `.wasm`. */
  readonly wasmPath: string;
}

/**
 * Supported languages (SPEC §4.2 requires ≥ 15 at v1).
 *
 * Every grammar here ships a prebuilt `.wasm`, so adding a language costs a
 * dependency and a row — no compiler, no build step. That is the dividend of
 * choosing WASM over native bindings in ADR-001.
 *
 * Coverage matters more than it looks: a file in an unindexed language falls
 * back to whole-file reads entirely, so the graph contributes nothing to a task
 * in that language.
 */
export const LANGUAGES: readonly LanguageSpec[] = [
  {
    id: "typescript",
    extensions: ["ts", "mts", "cts"],
    wasmPath: "tree-sitter-typescript/tree-sitter-typescript.wasm",
  },
  { id: "tsx", extensions: ["tsx"], wasmPath: "tree-sitter-typescript/tree-sitter-tsx.wasm" },
  {
    id: "javascript",
    extensions: ["js", "mjs", "cjs", "jsx"],
    wasmPath: "tree-sitter-javascript/tree-sitter-javascript.wasm",
  },
  {
    id: "python",
    extensions: ["py", "pyi"],
    wasmPath: "tree-sitter-python/tree-sitter-python.wasm",
  },
  { id: "go", extensions: ["go"], wasmPath: "tree-sitter-go/tree-sitter-go.wasm" },
  { id: "java", extensions: ["java"], wasmPath: "tree-sitter-java/tree-sitter-java.wasm" },
  { id: "c", extensions: ["c", "h"], wasmPath: "tree-sitter-c/tree-sitter-c.wasm" },
  {
    id: "cpp",
    extensions: ["cpp", "cc", "cxx", "hpp", "hh"],
    wasmPath: "tree-sitter-cpp/tree-sitter-cpp.wasm",
  },
  {
    id: "csharp",
    extensions: ["cs"],
    wasmPath: "tree-sitter-c-sharp/tree-sitter-c_sharp.wasm",
  },
  { id: "rust", extensions: ["rs"], wasmPath: "tree-sitter-rust/tree-sitter-rust.wasm" },
  { id: "ruby", extensions: ["rb"], wasmPath: "tree-sitter-ruby/tree-sitter-ruby.wasm" },
  { id: "php", extensions: ["php"], wasmPath: "tree-sitter-php/tree-sitter-php.wasm" },
  { id: "bash", extensions: ["sh", "bash"], wasmPath: "tree-sitter-bash/tree-sitter-bash.wasm" },
] as const;

const byExtension = new Map<string, LanguageSpec>(
  LANGUAGES.flatMap((spec) => spec.extensions.map((ext) => [ext, spec] as const)),
);

export const languageFor = (path: string): LanguageSpec | undefined =>
  byExtension.get(path.split(".").pop()?.toLowerCase() ?? "");

/**
 * Node types that define a symbol, mapped to our node kinds.
 *
 * Union across every supported grammar rather than a table per language.
 * Tree-sitter node type names are largely conventional across grammars
 * (`function_definition`, `class_declaration`), and where they differ the names
 * do not collide — so one map stays correct and avoids a dispatch layer that
 * would need updating for every new language.
 */
const DECLARATION_KINDS: Record<string, NodeKind> = {
  // JavaScript / TypeScript
  function_declaration: "function",
  generator_function_declaration: "function",
  class_declaration: "class",
  method_definition: "method",
  interface_declaration: "type",
  type_alias_declaration: "type",
  enum_declaration: "type",
  // Python, C, C++, PHP, Ruby, Bash
  function_definition: "function",
  class_definition: "class",
  method: "method",
  singleton_method: "method",
  // Go
  method_declaration: "method",
  type_declaration: "type",
  // Java, C#
  constructor_declaration: "method",
  record_declaration: "class",
  struct_declaration: "type",
  // C / C++
  class_specifier: "class",
  struct_specifier: "type",
  enum_specifier: "type",
  // Rust
  function_item: "function",
  struct_item: "type",
  enum_item: "type",
  trait_item: "type",
  impl_item: "class",
  // Ruby
  module: "module",
};

interface SyntaxNodeLike {
  type: string;
  text: string;
  startPosition: { row: number };
  endPosition: { row: number };
  childCount: number;
  child(index: number): SyntaxNodeLike | null;
  childForFieldName(name: string): SyntaxNodeLike | null;
  previousSibling: SyntaxNodeLike | null;
  parent: SyntaxNodeLike | null;
}

let initialized = false;
const grammars = new Map<string, Language>();

/** Loads and caches a grammar. Parser initialization happens once per process. */
async function grammarFor(spec: LanguageSpec): Promise<Language> {
  if (!initialized) {
    await Parser.init();
    initialized = true;
  }

  const cached = grammars.get(spec.id);
  if (cached) return cached;

  const language = await Language.load(require.resolve(spec.wasmPath));
  grammars.set(spec.id, language);
  return language;
}

/**
 * Renders a signature: name, parameters and return type, never a body.
 *
 * SPEC §4.3 requires responses to be signatures, and computing them at index
 * time means a query never has to open a file.
 */
function signatureOf(node: SyntaxNodeLike, name: string): string {
  const params = node.childForFieldName("parameters")?.text ?? "";
  const returnType = node.childForFieldName("return_type")?.text ?? "";
  const typeParams = node.childForFieldName("type_parameters")?.text ?? "";
  return `${name}${typeParams}${params}${returnType}`.replace(/\s+/g, " ").trim();
}

/**
 * Wrappers that sit between a declaration and its doc comment.
 *
 * `export function f()` parses as an `export_statement` containing the
 * declaration, so the comment is a sibling of the wrapper, not of the
 * declaration. Without climbing these, every exported symbol loses its doc.
 */
const DECLARATION_WRAPPERS = new Set(["export_statement", "ambient_declaration"]);

/** First line of a leading doc comment, if the declaration has one. */
function docLineOf(node: SyntaxNodeLike): string | undefined {
  let outermost = node;
  while (outermost.parent && DECLARATION_WRAPPERS.has(outermost.parent.type)) {
    outermost = outermost.parent;
  }

  const previous = outermost.previousSibling;
  if (previous?.type !== "comment") return undefined;

  for (const raw of previous.text.split("\n")) {
    const line = raw.replace(/^\s*(?:\/\*\*?|\*\/|\*|\/\/)\s?/, "").trim();
    if (line !== "" && line !== "/") return line.slice(0, 200);
  }
  return undefined;
}

/**
 * Extracts a declaration's name across grammar dialects.
 *
 * Most grammars expose a `name` field. C and C++ do not: a
 * `function_definition` carries a `declarator` chain that has to be walked down
 * to the identifier. Without this, every C and C++ symbol is invisible to the
 * graph while the file still parses cleanly — a silent gap rather than an error.
 */
function declarationName(node: SyntaxNodeLike): string | undefined {
  const direct = node.childForFieldName("name")?.text;
  if (direct) return direct;

  // C/C++: function_definition → declarator → … → identifier
  let declarator = node.childForFieldName("declarator");
  for (let depth = 0; declarator && depth < 6; depth++) {
    if (declarator.type === "identifier" || declarator.type === "field_identifier") {
      return declarator.text;
    }
    declarator = declarator.childForFieldName("declarator");
  }
  return undefined;
}

/** Nearest enclosing class name, so methods get a qualified id. */
function enclosingClass(node: SyntaxNodeLike): string | undefined {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (parent.type === "class_declaration" || parent.type === "class_specifier") {
      return declarationName(parent);
    }
  }
  return undefined;
}

export interface IndexedFile {
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
  readonly hash: string;
}

/**
 * Parses one file into nodes and edges.
 *
 * Call edges are recorded by callee *name*, not resolved identity: resolving
 * requires cross-file type information, which is SCIP's job. A name-based edge
 * is imprecise but useful, and the alternative is no edge at all until SCIP
 * lands. Unresolvable edges are dropped at query time by the store's join.
 */
export async function indexSource(
  repoRelativePath: string,
  source: string,
): Promise<IndexedFile | undefined> {
  const spec = languageFor(repoRelativePath);
  if (!spec) return undefined;

  // Grammar first: `new Parser()` throws unless `Parser.init()` has already
  // run, and loading the grammar is what runs it.
  const grammar = await grammarFor(spec);
  const parser = new Parser();
  parser.setLanguage(grammar);
  const tree = parser.parse(source);
  if (!tree) return undefined;

  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const declaredHere = new Map<string, string>();

  const fileNode: GraphNode = {
    id: repoRelativePath,
    kind: "file",
    name: repoRelativePath.split("/").pop() ?? repoRelativePath,
    path: repoRelativePath,
    startLine: 1,
    endLine: source.split("\n").length,
    language: spec.id,
  };
  nodes.push(fileNode);

  // A test file's symbols are tagged as tests so `tests_for` can find them.
  const isTestFile = /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(repoRelativePath);

  const visit = (node: SyntaxNodeLike): void => {
    const declKind = DECLARATION_KINDS[node.type];
    if (declKind) {
      const name = declarationName(node);
      if (name) {
        const owner = declKind === "method" ? enclosingClass(node) : undefined;
        const qualified = owner ? `${owner}.${name}` : name;
        const id = `${repoRelativePath}#${qualified}`;
        const doc = docLineOf(node);

        nodes.push({
          id,
          kind: isTestFile ? "test" : declKind,
          name,
          path: repoRelativePath,
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          signature: signatureOf(node, qualified),
          ...(doc === undefined ? {} : { docLine: doc }),
          language: spec.id,
        });
        declaredHere.set(name, id);
        edges.push({ from: repoRelativePath, to: id, kind: "references" });

        if (declKind === "class") {
          const heritage = node.childForFieldName("superclass")?.text;
          if (heritage) edges.push({ from: id, to: heritage, kind: "inherits" });
        }
      }
    }

    if (node.type === "import_statement") {
      const source_ = node.childForFieldName("source")?.text?.replace(/['"]/g, "");
      if (source_) edges.push({ from: repoRelativePath, to: source_, kind: "imports" });
    }

    if (node.type === "call_expression") {
      const callee = node.childForFieldName("function")?.text;
      if (callee) {
        // Enclosing declaration owns the call; falls back to the file.
        let owner = repoRelativePath;
        for (let parent = node.parent; parent; parent = parent.parent) {
          const kind = DECLARATION_KINDS[parent.type];
          if (kind) {
            const parentName = declarationName(parent);
            if (parentName) {
              const parentOwner = kind === "method" ? enclosingClass(parent) : undefined;
              owner = `${repoRelativePath}#${parentOwner ? `${parentOwner}.${parentName}` : parentName}`;
            }
            break;
          }
        }
        const bare = callee.split(".").pop() ?? callee;
        edges.push({ from: owner, to: bare, kind: "calls" });
      }
    }

    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child) visit(child);
    }
  };

  visit(tree.rootNode as unknown as SyntaxNodeLike);

  // Rewrite call edges that target a symbol declared in this file, so
  // same-file calls resolve to real ids instead of bare names.
  const resolved = edges.map((edge) =>
    edge.kind === "calls" && declaredHere.has(edge.to)
      ? { ...edge, to: declaredHere.get(edge.to) as string }
      : edge,
  );

  return { nodes, edges: resolved, hash: hashContent(source) };
}

/**
 * Rewrites bare-name call edges to real symbol ids where the name is
 * unambiguous across the repository.
 *
 * Parsing resolves calls only within a file, because anything more needs
 * cross-file type information — SCIP's job (SPEC §4.2). But most call targets
 * in a real codebase have exactly one declaration, and for those a name is
 * enough. This pass converts them, which is what makes "who calls this"
 * answerable across files before SCIP lands.
 *
 * Ambiguous names are deliberately left unresolved rather than guessed. A wrong
 * edge is worse than a missing one: it sends `impact()` after the wrong
 * symbols, and the model trusts the answer.
 */
export function resolveCrossFileCalls(store: GraphStore): { resolved: number; ambiguous: number } {
  const byName = new Map<string, string[]>();
  for (const node of store.findNodes({})) {
    if (node.kind === "file") continue;
    const ids = byName.get(node.name);
    if (ids) ids.push(node.id);
    else byName.set(node.name, [node.id]);
  }

  const additions: GraphEdge[] = [];
  let ambiguous = 0;

  for (const [name, ids] of byName) {
    if (ids.length !== 1) {
      ambiguous += 1;
      continue;
    }
    const target = ids[0];
    if (target === undefined) continue;

    // Callers recorded against the bare name become callers of the symbol.
    for (const caller of store.dependents({ id: name, kind: "calls", depth: 1 })) {
      additions.push({ from: caller.id, to: target, kind: "calls" });
    }
  }

  store.putEdges(additions);
  return { resolved: additions.length, ambiguous };
}

export interface IndexResult {
  readonly filesIndexed: number;
  readonly filesSkipped: number;
  readonly nodes: number;
  readonly edges: number;
  readonly durationMs: number;
}

/**
 * Indexes files into a store, skipping any whose content hash is unchanged.
 *
 * The skip is what makes reindexing cheap enough for a watcher (SPEC §4.2:
 * incremental ≥ 4× faster than full).
 */
export async function indexFiles(
  store: GraphStore,
  repoRoot: string,
  absolutePaths: readonly string[],
  options: { force?: boolean } = {},
): Promise<IndexResult> {
  const started = Date.now();
  let filesIndexed = 0;
  let filesSkipped = 0;
  let nodeCount = 0;
  let edgeCount = 0;

  for (const absolute of absolutePaths) {
    const path = relative(repoRoot, absolute).split("\\").join("/");
    if (!languageFor(path)) continue;

    let source: string;
    try {
      source = readFileSync(absolute, "utf8");
    } catch {
      continue;
    }

    const hash = hashContent(source);
    if (!options.force && store.getFileRecord(path)?.hash === hash) {
      filesSkipped += 1;
      continue;
    }

    const indexed = await indexSource(path, source);
    if (!indexed) continue;

    // Replace rather than merge: a symbol deleted from the file must not
    // survive in the graph.
    store.removeFile(path);
    store.putNodes(indexed.nodes);
    store.putEdges(indexed.edges);
    store.putFileRecord({ path, hash, indexedAt: new Date().toISOString() });

    filesIndexed += 1;
    nodeCount += indexed.nodes.length;
    edgeCount += indexed.edges.length;
  }

  return {
    filesIndexed,
    filesSkipped,
    nodes: nodeCount,
    edges: edgeCount,
    durationMs: Date.now() - started,
  };
}
