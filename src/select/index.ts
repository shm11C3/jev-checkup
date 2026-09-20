import { promises as fs } from "node:fs";
import { execFile as execFileCallback } from "node:child_process";
import * as path from "node:path";
import { promisify } from "node:util";
import { Lang, parse } from "@ast-grep/napi";
import { minimatch } from "minimatch";
import type { SgNode } from "@ast-grep/napi";
import type {
  AspectDefinition,
  Config,
  ContextMode,
  EvidenceSource,
  Json,
  PreparedTarget,
  Scope,
  ScopeFile,
  Selection,
  Questions,
} from "../types.js";
import { hash, hashText, subjectRevision } from "../shared/hash.js";

const SOURCE_EXTENSIONS = new Set([
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
]);
const DEFAULT_INCLUDE = ["**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}"];
const LANGUAGE_NAMES = ["javascript", "typescript", "tsx"];
const MAX_STATE_PLUS_LONGEST_QUESTION = 32_000;
const MAX_STATE_PLUS_ALL_QUESTIONS = 64_000;
const APPROX_TOKEN_BYTES = 3;
const TEST_SUFFIX = /(?:\.test|\.spec)$/i;
const OMITTED_DIRECTORY_NAMES = new Set([
  ".git",
  ".jev-checkup",
  ".next",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "target",
]);
const execFile = promisify(execFileCallback);

type Ast = SgNode;

interface RangeInfo {
  start: number;
  end: number;
  startLine: number;
  endLine: number;
}

interface CalleeInfo {
  base: string;
  modifiers: string[];
  factoryCall: boolean;
}

interface CallRecord {
  node: Ast;
  range: RangeInfo;
  title: string;
  titleNode: Ast;
  callback: Ast;
  body: Ast | null;
  path: string[];
  skipped: boolean;
  modifiers: string[];
  each: boolean;
}

interface DescribeRecord {
  node: Ast;
  range: RangeInfo;
  title: string | null;
  callback: Ast | null;
  body: Ast | null;
  skipped: boolean;
  dynamic: boolean;
  reported: boolean;
}

interface ParsedFile {
  relativePath: string;
  rawSource: string;
  source: string;
  ast: Ast;
}

interface FileEntry {
  relativePath: string;
  absolutePath: string;
  rawSource?: string;
  source?: string;
  ast?: Ast;
  status: ScopeFile["status"];
  reason?: string;
  hash?: string;
}

interface Replacement {
  start: number;
  end: number;
  text: string;
}

function field(node: Ast, name: string): Ast | null {
  return (node as unknown as { field: (fieldName: string) => Ast | null }).field(name);
}

function callExpressions(root: Ast): Ast[] {
  return root.findAll({ rule: { kind: "call_expression" } } as never) as Ast[];
}

function rangeOf(node: Ast, source: string): RangeInfo {
  const range = node.range();
  return {
    // @ast-grep/napi exposes JavaScript string offsets here. Keep the source
    // slices in the same coordinate system so non-ASCII titles stay intact.
    start: range.start.index,
    end: range.end.index,
    startLine: range.start.line + 1,
    endLine: range.end.line + 1,
  };
}

function sourceLanguage(relativePath: string): Lang {
  const extension = path.extname(relativePath).toLowerCase();
  if (extension === ".tsx") return Lang.Tsx;
  if (extension === ".ts" || extension === ".mts" || extension === ".cts") {
    return Lang.TypeScript;
  }
  return Lang.JavaScript;
}

function normaliseSource(source: string): string {
  return source.replace(/\r\n?/g, "\n");
}

function isInside(outer: RangeInfo, inner: RangeInfo): boolean {
  return outer.start <= inner.start && outer.end >= inner.end;
}

function parseLiteral(node: Ast | null): string | null {
  if (!node) return null;
  const kind = node.kind();
  const text = node.text();
  if (kind === "string") {
    return decodeStringLiteral(text);
  }
  if (kind === "template_string" && !text.includes("${")) {
    return decodeStringLiteral(text);
  }
  return null;
}

function decodeStringLiteral(text: string): string | null {
  if (text.length < 2) return null;
  const quote = text[0];
  if (quote !== "'" && quote !== '"' && quote !== "`") return null;
  if (text[text.length - 1] !== quote) return null;
  const body = text.slice(1, -1);
  let output = "";
  for (let index = 0; index < body.length; index += 1) {
    const character = body[index];
    if (character !== "\\") {
      output += character;
      continue;
    }
    const next = body[++index];
    if (next === undefined) return null;
    switch (next) {
      case "n": output += "\n"; break;
      case "r": output += "\r"; break;
      case "t": output += "\t"; break;
      case "b": output += "\b"; break;
      case "f": output += "\f"; break;
      case "v": output += "\v"; break;
      case "0": output += "\0"; break;
      case "x": {
        const hex = body.slice(index + 1, index + 3);
        if (!/^[0-9a-f]{2}$/i.test(hex)) return null;
        output += String.fromCharCode(Number.parseInt(hex, 16));
        index += 2;
        break;
      }
      case "u": {
        if (body[index + 1] === "{") {
          const close = body.indexOf("}", index + 2);
          if (close < 0) return null;
          const hex = body.slice(index + 2, close);
          if (!/^[0-9a-f]+$/i.test(hex)) return null;
          output += String.fromCodePoint(Number.parseInt(hex, 16));
          index = close;
        } else {
          const hex = body.slice(index + 1, index + 5);
          if (!/^[0-9a-f]{4}$/i.test(hex)) return null;
          output += String.fromCharCode(Number.parseInt(hex, 16));
          index += 4;
        }
        break;
      }
      case "\n": break;
      case "\r": if (body[index + 1] === "\n") index += 1; break;
      default: output += next; break;
    }
  }
  return output;
}

function inspectCallee(node: Ast | null): CalleeInfo | null {
  if (!node) return null;
  if (node.kind() === "identifier") {
    return { base: node.text(), modifiers: [], factoryCall: false };
  }
  if (node.kind() === "member_expression") {
    const object = field(node, "object");
    const property = field(node, "property") ?? field(node, "property_identifier");
    const inner = inspectCallee(object);
    if (!inner || !property || property.kind() !== "property_identifier") return null;
    return {
      base: inner.base,
      modifiers: [...inner.modifiers, property.text()],
      factoryCall: inner.factoryCall,
    };
  }
  if (node.kind() === "call_expression") {
    const inner = inspectCallee(field(node, "function"));
    if (!inner || !inner.modifiers.includes("each")) return null;
    return { ...inner, factoryCall: true };
  }
  return null;
}

function callbackBody(callback: Ast): Ast | null {
  return field(callback, "body");
}

function isFunctionNode(node: Ast | null | undefined): node is Ast {
  if (!node) return false;
  return node.kind() === "arrow_function" || node.kind() === "function_expression";
}

function directArguments(node: Ast): Ast[] {
  return field(node, "arguments")?.namedChildren() ?? [];
}

function classifyFamily(node: Ast): "test" | "describe" | null {
  const callee = inspectCallee(field(node, "function"));
  if (!callee || (callee.base !== "it" && callee.base !== "test" && callee.base !== "describe")) {
    return null;
  }
  return callee.base === "describe" ? "describe" : "test";
}

function supportedModifiers(modifiers: string[]): boolean {
  return modifiers.every((modifier) =>
    modifier === "each" || modifier === "only" || modifier === "skip" ||
    modifier === "concurrent" || modifier === "todo" || modifier === "fails",
  );
}

function isEachCall(callee: CalleeInfo): boolean {
  return callee.modifiers.includes("each");
}

function testTitleAndCallback(node: Ast): {
  callee: CalleeInfo | null;
  titleNode: Ast | null;
  title: string | null;
  callback: Ast | null;
} {
  const callee = inspectCallee(field(node, "function"));
  const args = directArguments(node);
  const titleNode = args[0] ?? null;
  const callback = args[1] ?? null;
  return {
    callee,
    titleNode,
    title: parseLiteral(titleNode),
    callback: isFunctionNode(callback) ? callback : null,
  };
}

function isDynamicFamilyCall(node: Ast): boolean {
  const functionNode = field(node, "function");
  if (!functionNode) return false;
  const callee = inspectCallee(functionNode);
  if (callee && (callee.base === "it" || callee.base === "test" || callee.base === "describe")) return true;
  // A malformed/unsupported member chain can still have a literal base. This
  // intentionally uses AST descendants, never source bracket matching.
  const identifier = functionNode.find("it") ?? functionNode.find("test") ?? functionNode.find("describe");
  return identifier !== null;
}

function describeCalls(calls: Ast[], source: string, diagnostics: string[]): DescribeRecord[] {
  const describes: DescribeRecord[] = [];
  for (const node of calls) {
    if (classifyFamily(node) !== "describe") continue;
    const callee = inspectCallee(field(node, "function"));
    if (callee && isEachCall(callee) && !callee.factoryCall && directArguments(node).length === 1) continue;
    const info = testTitleAndCallback(node);
    const range = rangeOf(node, source);
    const dynamic = !callee || !supportedModifiers(callee.modifiers) ||
      (isEachCall(callee) && !callee.factoryCall) || info.title === null || info.callback === null;
    if (dynamic) {
      diagnostics.push(`dynamic or unsupported describe name/form at line ${range.startLine}`);
    }
    const modifiers = callee?.modifiers ?? [];
    describes.push({
      node,
      range,
      title: dynamic ? null : info.title,
      callback: info.callback,
      body: info.callback ? callbackBody(info.callback) : null,
      skipped: modifiers.includes("skip") || modifiers.includes("todo"),
      dynamic,
      reported: false,
    });
  }
  return describes;
}

function testCalls(
  calls: Ast[],
  source: string,
  describes: DescribeRecord[],
  diagnostics: string[],
): { records: CallRecord[]; skipped: number } {
  const records: CallRecord[] = [];
  let skipped = 0;
  for (const node of calls) {
    if (classifyFamily(node) !== "test") continue;
    const range = rangeOf(node, source);
    const callee = inspectCallee(field(node, "function"));
    if (callee && isEachCall(callee) && !callee.factoryCall && directArguments(node).length === 1) continue;
    const info = testTitleAndCallback(node);
    const dynamic = !callee || !supportedModifiers(callee.modifiers) ||
      (isEachCall(callee) && !callee.factoryCall) || info.title === null || info.callback === null;
    const modifiers = callee?.modifiers ?? [];
    const skip = modifiers.includes("skip") || modifiers.includes("todo");
    if (skip && info.title !== null) {
      skipped += 1;
      continue;
    }
    if (dynamic) {
      diagnostics.push(`dynamic or unsupported test name/form at line ${range.startLine}`);
      continue;
    }
    if (!info.titleNode || !info.callback || info.title === null || !callee) continue;
    const ancestors = describes
      .filter((describe) => isInside(describe.range, range) && describe.range.start !== range.start)
      .sort((a, b) => a.range.start - b.range.start || b.range.end - a.range.end);
    let blocked = false;
    let skippedByDescribe = false;
    const describePath: string[] = [];
    for (const describe of ancestors) {
      if (describe.dynamic || describe.title === null) {
        blocked = true;
        if (!describe.reported) {
          diagnostics.push(`test is inside a dynamic or unsupported describe at line ${range.startLine}`);
          describe.reported = true;
        }
        break;
      }
      describePath.push(describe.title);
      if (describe.skipped) skippedByDescribe = true;
    }
    if (blocked) continue;
    if (skippedByDescribe) {
      skipped += 1;
      continue;
    }
    records.push({
      node,
      range,
      title: info.title,
      titleNode: info.titleNode,
      callback: info.callback,
      body: callbackBody(info.callback),
      path: describePath,
      skipped: false,
      modifiers,
      each: isEachCall(callee),
    });
  }
  return { records, skipped };
}

function allOccurrences(source: string, needle: string): number[] {
  if (!needle) return [];
  const indexes: number[] = [];
  let from = 0;
  while (from <= source.length - needle.length) {
    const index = source.indexOf(needle, from);
    if (index < 0) break;
    indexes.push(index);
    from = index + Math.max(1, needle.length);
  }
  return indexes;
}

function snippetCandidates(node: Ast): string[] {
  const candidates: string[] = [];
  for (const candidate of node.findAll({ rule: { kind: "call_expression" } } as never) as Ast[]) {
    const text = candidate.text();
    if (text.includes("\n") || text.length < 5 || text.length > 240) continue;
    candidates.push(text);
  }
  for (const kind of ["string", "number", "true", "false", "null"] as const) {
    for (const candidate of node.findAll({ rule: { kind } } as never) as Ast[]) {
      const text = candidate.text();
      if (text.includes("\n") || text.length < 3 || text.length > 120) continue;
      candidates.push(text);
    }
  }
  return candidates;
}

function pickSnippet(node: Ast, source: string, excluded: Ast | null = null): string | null {
  for (const candidate of snippetCandidates(node)) {
    if (allOccurrences(source, candidate).length === 1) return candidate;
  }
  return null;
}

function lineId(line: number, prefix = "L"): string {
  return `${prefix}${String(line).padStart(4, "0")}`;
}

function numberLines(source: string, prefix = "L"): string {
  return source.split("\n").map((line, index) => `${lineId(index + 1, prefix)}| ${line}`).join("\n");
}

function foldBodyText(source: string, body: RangeInfo): string {
  const bodyText = source.slice(body.start, body.end);
  if (!bodyText.startsWith("{") || !bodyText.endsWith("}")) return bodyText;
  const inner = bodyText.slice(1, -1);
  const lineBreaks = (inner.match(/\n/g) ?? []).length;
  const omitted = `/* body of this other test omitted (${Math.max(1, lineBreaks)} lines) */`;
  if (lineBreaks === 0) return `{ ${omitted} }`;
  const lineStart = source.lastIndexOf("\n", body.start) + 1;
  const indent = source.slice(lineStart, body.start).match(/^[ \t]*/)?.[0] ?? "";
  return `{\n${indent}${omitted}${"\n".repeat(Math.max(0, lineBreaks - 1))}\n${indent}}`;
}

function foldedSource(source: string, records: CallRecord[], target: CallRecord): string {
  const replacements: Replacement[] = [];
  for (const record of records) {
    if (record.node.id() === target.node.id() || isInside(target.range, record.range) || !record.body || record.body.kind() !== "statement_block") continue;
    const body = rangeOf(record.body, source);
    if (body.end <= body.start + 1) continue;
    replacements.push({
      start: body.start,
      end: body.end,
      text: foldBodyText(source, body),
    });
  }
  replacements.sort((a, b) => b.start - a.start);
  let folded = source;
  let replacedStart = Number.POSITIVE_INFINITY;
  let replacedEnd = Number.NEGATIVE_INFINITY;
  for (const replacement of replacements) {
    if (replacement.end > replacedStart && replacement.start < replacedEnd) continue;
    folded = folded.slice(0, replacement.start) + replacement.text + folded.slice(replacement.end);
    replacedStart = replacement.start;
    replacedEnd = replacement.end;
  }
  return folded;
}

function extractLines(source: string, startLine: number, endLine: number): string {
  return numberLines(source, "L").split("\n").slice(startLine - 1, endLine).join("\n");
}

function replacePlaceholders(value: unknown, replacements: Record<string, string>): unknown {
  if (typeof value === "string") {
    let result = value;
    for (const [placeholder, replacement] of Object.entries(replacements)) {
      result = result.split(placeholder).join(replacement);
    }
    return result;
  }
  if (Array.isArray(value)) return value.map((item) => replacePlaceholders(item, replacements));
  if (value !== null && typeof value === "object") {
    const replaceKey = (key: string): string => {
      let result = key;
      for (const [placeholder, replacement] of Object.entries(replacements)) {
        result = result.split(placeholder).join(replacement);
      }
      return result;
    };
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [replaceKey(key), replacePlaceholders(item, replacements)]));
  }
  return value;
}

function targetQuestions(
  definition: AspectDefinition,
  record: CallRecord,
  source: string,
  ownSnippet: string | null,
  siblingSnippet: string | null,
  folded: string,
): Questions {
  const key = `t${String(record.range.startLine).padStart(4, "0")}`;
  const replacements = {
    "{test_key}": key,
    "{title}": record.title,
    "{describe_path}": record.path.join(" > "),
    "{start_line}": String(record.range.startLine),
    "{end_line}": String(record.range.endLine),
    "{start_line_id}": lineId(record.range.startLine),
    "{end_line_id}": lineId(record.range.endLine),
    "{test_code}": extractLines(folded, record.range.startLine, record.range.endLine),
    "{own_snippet}": ownSnippet ?? "",
    "{sibling_snippet}": siblingSnippet ?? "",
  };
  const questions = replacePlaceholders(definition.questions, replacements) as Questions;
  if (!ownSnippet) delete questions[`${key}__ctl_own_snippet`];
  if (!siblingSnippet) delete questions[`${key}__ctl_sibling_snippet`];
  return questions;
}

function targetState(
  relativePath: string,
  record: CallRecord,
  folded: string,
  production: ParsedFile | null,
): Json {
  const key = `t${String(record.range.startLine).padStart(4, "0")}`;
  const numbered = numberLines(folded, "L");
  let source = numbered;
  if (production) {
    source += `\n\n// ===== production module under test: ${production.relativePath} (line ids start with P) =====\n`;
    source += numberLines(production.source, "P");
  }
  return {
    file_path: relativePath,
    source,
    target_tests: {
      [key]: {
        title: record.title,
        inside: record.path.join(" > "),
        first_line: lineId(record.range.startLine),
        last_line: lineId(record.range.endLine),
        code: extractLines(folded, record.range.startLine, record.range.endLine),
      },
    },
  };
}

function approximateTokens(value: unknown): number {
  return Math.ceil(Buffer.byteLength(JSON.stringify(value), "utf8") / APPROX_TOKEN_BYTES);
}

function exceedsInputLimit(state: Json, questions: Questions): boolean {
  const stateTokens = approximateTokens(state);
  const questionTokens = Object.values(questions).map((question) => approximateTokens(question));
  const longest = Math.max(0, ...questionTokens);
  const total = questionTokens.reduce((sum, tokens) => sum + tokens, 0);
  return stateTokens + longest > MAX_STATE_PLUS_LONGEST_QUESTION ||
    stateTokens + total > MAX_STATE_PLUS_ALL_QUESTIONS;
}

function normaliseRelative(value: string): string | null {
  const replaced = value.replaceAll("\\", "/");
  if (!replaced || replaced.includes("\0") || path.posix.isAbsolute(replaced)) return null;
  const normalised = path.posix.normalize(replaced);
  if (normalised === ".." || normalised.startsWith("../")) return null;
  return normalised === "." ? "." : normalised.replace(/^\.\//, "");
}

function pathIsWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function matchesAny(relativePath: string, patterns: string[]): boolean {
  return patterns.some((pattern) => minimatch(relativePath, pattern, { dot: true, matchBase: true }));
}

function effectivePatterns(config: Config): { include: string[]; exclude: string[] } {
  const include = config.include?.length ? [...config.include] : [...DEFAULT_INCLUDE];
  return {
    include: [...new Set(include.map((value) => value.replaceAll("\\", "/")))].sort(),
    exclude: [...new Set((config.exclude ?? []).map((value) => value.replaceAll("\\", "/")))].sort(),
  };
}

async function enumerateFiles(root: string, paths: string[], errors: string[]): Promise<string[]> {
  const files: string[] = [];
  const visited = new Set<string>();
  async function visit(relativeInput: string): Promise<void> {
    const normalised = normaliseRelative(relativeInput);
    if (!normalised) {
      errors.push(`unsafe scope path: ${relativeInput}`);
      return;
    }
    const absolute = path.resolve(root, normalised);
    if (!pathIsWithin(root, absolute)) {
      errors.push(`unsafe scope path: ${relativeInput}`);
      return;
    }
    let stat;
    try {
      stat = await fs.lstat(absolute);
    } catch (error) {
      errors.push(`cannot enumerate ${normalised}: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    if (stat.isSymbolicLink()) {
      errors.push(`skipped symlink scope path: ${normalised}`);
      return;
    }
    if (stat.isFile()) {
      files.push(normalised === "." ? path.basename(absolute) : normalised);
      return;
    }
    if (!stat.isDirectory()) return;
    if (visited.has(absolute)) return;
    visited.add(absolute);
    let entries;
    try {
      entries = await fs.readdir(absolute, { withFileTypes: true });
    } catch (error) {
      errors.push(`cannot enumerate ${normalised}: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.isDirectory() && OMITTED_DIRECTORY_NAMES.has(entry.name)) continue;
      const child = normalised === "." ? entry.name : path.posix.join(normalised, entry.name);
      await visit(child);
    }
  }
  for (const scopePath of paths) await visit(scopePath);
  return [...new Set(files)].sort();
}

function parseFile(relativePath: string, rawSource: string): ParsedFile {
  const source = normaliseSource(rawSource);
  const ast = parse(sourceLanguage(relativePath), source).root();
  return { relativePath, rawSource, source, ast };
}

function parseHasErrors(ast: Ast): boolean {
  if (ast.kind() === "ERROR") return true;
  return (ast.findAll({ rule: { kind: "ERROR" } } as never) as Ast[]).length > 0;
}

function importSpecifier(node: Ast): string | null {
  const source = field(node, "source");
  return parseLiteral(source);
}

function localImportSpecifiers(ast: Ast): { specifier: string; mocked: boolean }[] {
  const imports: { specifier: string; mocked: boolean }[] = [];
  for (const node of ast.findAll({ rule: { kind: "import_statement" } } as never) as Ast[]) {
    if (/^\s*import\s+type\b/.test(node.text())) continue;
    const specifier = importSpecifier(node);
    if (specifier) imports.push({ specifier, mocked: false });
  }
  for (const node of callExpressions(ast)) {
    const callee = inspectCallee(field(node, "function"));
    const args = directArguments(node);
    const specifier = parseLiteral(args[0] ?? null);
    if (!specifier) continue;
    if (callee?.base === "require" && callee.modifiers.length === 0) {
      imports.push({ specifier, mocked: false });
    }
    if (field(node, "function")?.kind() === "import") {
      imports.push({ specifier, mocked: false });
    }
    if (callee?.modifiers.at(-1) === "mock" && (callee.base === "vi" || callee.base === "jest" || callee.base === "mock")) {
      imports.push({ specifier, mocked: true });
    }
  }
  return imports;
}

function resolveRelativeImport(
  importer: string,
  specifier: string,
  files: Map<string, FileEntry>,
): string[] {
  if (!specifier.startsWith(".")) return [];
  const importerDirectory = path.posix.dirname(importer);
  const base = normaliseRelative(path.posix.join(importerDirectory, specifier));
  if (!base) return [];
  const candidates: string[] = [];
  const extension = path.posix.extname(base);
  if (extension) candidates.push(base);
  else {
    for (const suffix of SOURCE_EXTENSIONS) candidates.push(`${base}${suffix}`);
    for (const suffix of SOURCE_EXTENSIONS) candidates.push(path.posix.join(base, `index${suffix}`));
  }
  return candidates.filter((candidate) => files.has(candidate));
}

function productionModule(
  parsed: ParsedFile,
  files: Map<string, FileEntry>,
): { file: ParsedFile | null; reason?: string } {
  const basename = path.posix.basename(parsed.relativePath, path.posix.extname(parsed.relativePath)).replace(TEST_SUFFIX, "");
  const imports = localImportSpecifiers(parsed.ast);
  const mocked = new Set(imports.filter((item) => item.mocked).map((item) => item.specifier));
  const candidates = new Set<string>();
  for (const item of imports) {
    if (item.mocked || mocked.has(item.specifier)) continue;
    const resolvedBase = normaliseRelative(path.posix.join(path.posix.dirname(parsed.relativePath), item.specifier));
    const importedStem = resolvedBase ? path.posix.basename(resolvedBase, path.posix.extname(resolvedBase)) : "";
    for (const candidate of resolveRelativeImport(parsed.relativePath, item.specifier, files)) {
      const candidateBase = path.posix.basename(candidate, path.posix.extname(candidate));
      const nameMatches = (value: string): boolean => value === basename || basename.startsWith(`${value}.`) || basename.endsWith(`.${value}`);
      if (nameMatches(candidateBase) || nameMatches(importedStem)) {
        candidates.add(candidate);
      }
    }
  }
  if (candidates.size !== 1) return { file: null, reason: "no_unique_named_import" };
  const relativePath = [...candidates][0];
  if (!relativePath) return { file: null, reason: "no_unique_named_import" };
  const entry = files.get(relativePath);
  if (!entry?.source || entry.rawSource === undefined || !entry.ast) return { file: null, reason: "no_unique_named_import" };
  return { file: { relativePath, rawSource: entry.rawSource, source: entry.source, ast: entry.ast } };
}

function sanitiseRemote(remote: string): string {
  let value = remote.trim();
  value = value.replace(/^https?:\/\/[^/]*@/i, "https://");
  value = value.replace(/^ssh:\/\/[^/]*@/i, "ssh://");
  value = value.replace(/^git@([^:]+):/, "$1/");
  value = value.replace(/^https?:\/\//i, "");
  value = value.replace(/^ssh:\/\//i, "");
  return value.replace(/\.git(?:$|(?=#))/, "");
}

async function repositoryId(root: string, configured: string | undefined): Promise<string> {
  if (configured) return configured;
  let remote: string | null = null;
  try {
    const result = await execFile("git", ["-C", root, "config", "--get", "remote.origin.url"], { encoding: "utf8" });
    const value = typeof result.stdout === "string" ? result.stdout.split(/\r?\n/, 1)[0] : "";
    if (value) remote = sanitiseRemote(value);
  } catch {
    // A local-only repository is expected to have no Git remote.
  }
  let identityRoot = root;
  if (!remote) {
    try {
      identityRoot = await fs.realpath(root);
    } catch {
      // Keep the resolved path when the root disappeared during enumeration.
    }
  }
  return hashText(remote ? `remote:${remote}` : `path:${identityRoot}`);
}

function scopeId(
  repo: string,
  paths: string[],
  include: string[],
  exclude: string[],
): string {
  return hash({
    repositoryId: repo,
    paths: [...paths].sort(),
    include: [...include].sort(),
    exclude: [...exclude].sort(),
    languages: LANGUAGE_NAMES,
    selectionPolicy: "files@1",
  });
}

function safeRootPath(root: string): string {
  return path.resolve(root);
}

function targetFingerprint(
  definition: AspectDefinition,
  relativePath: string,
  record: CallRecord,
  occurrence: number,
): string {
  return hash({
    aspect: definition.id,
    file: relativePath,
    path: record.path,
    name: record.title,
    occurrence,
  });
}

function evidenceSources(relativePath: string, testHash: string, production: ParsedFile | null, sourceHashes: Record<string, string>): EvidenceSource[] {
  const sources: EvidenceSource[] = [{ file: relativePath, hash: testHash }];
  if (production) {
    const productionHash = sourceHashes[production.relativePath];
    if (productionHash) sources.push({ file: production.relativePath, hash: productionHash });
  }
  return sources.sort((a, b) => a.file.localeCompare(b.file));
}

async function prepareFileEntries(
  root: string,
  relativePaths: string[],
  include: string[],
  exclude: string[],
  errors: string[],
): Promise<{ entries: FileEntry[]; parsed: ParsedFile[]; complete: boolean }> {
  const entries: FileEntry[] = [];
  const parsed: ParsedFile[] = [];
  let complete = true;
  for (const relativePath of relativePaths) {
    const absolutePath = path.resolve(root, relativePath);
    const entry: FileEntry = { relativePath, absolutePath, status: "skipped" };
    const extension = path.extname(relativePath).toLowerCase();
    if (!SOURCE_EXTENSIONS.has(extension)) {
      entry.reason = "unsupported_file";
      entries.push(entry);
      continue;
    }
    if (!matchesAny(relativePath, include)) {
      entry.reason = "not_included";
      entries.push(entry);
      continue;
    }
    if (matchesAny(relativePath, exclude)) {
      entry.reason = "excluded";
      entries.push(entry);
      continue;
    }
    let rawSource: string;
    try {
      rawSource = await fs.readFile(absolutePath, "utf8");
    } catch (error) {
      entry.status = "error";
      entry.reason = "read_error";
      entries.push(entry);
      complete = false;
      errors.push(`${relativePath}: cannot read source (${error instanceof Error ? error.message : String(error)})`);
      continue;
    }
    entry.hash = hashText(rawSource);
    try {
      const file = parseFile(relativePath, rawSource);
      if (parseHasErrors(file.ast)) {
        entry.status = "error";
        entry.reason = "parse_error";
        entries.push(entry);
        complete = false;
        errors.push(`${relativePath}: parse error`);
        continue;
      }
      entry.status = "parsed";
      entry.rawSource = file.rawSource;
      entry.source = file.source;
      entry.ast = file.ast;
      entries.push(entry);
      parsed.push(file);
    } catch (error) {
      entry.status = "error";
      entry.reason = "parse_error";
      entries.push(entry);
      complete = false;
      errors.push(`${relativePath}: parse error (${error instanceof Error ? error.message : String(error)})`);
    }
  }
  return { entries, parsed, complete };
}

export async function selectTargets(
  root: string,
  paths: string[],
  config: Config,
  definition: AspectDefinition,
): Promise<Selection> {
  const resolvedRoot = safeRootPath(root);
  const errors: string[] = [];
  const { include, exclude } = effectivePatterns(config);
  const requestedPaths = paths.length ? paths : ["."];
  const normalizedPaths: string[] = [];
  for (const requestedPath of requestedPaths) {
    const normalized = normaliseRelative(requestedPath);
    if (!normalized) {
      errors.push(`unsafe scope path: ${requestedPath}`);
      continue;
    }
    if (!normalizedPaths.includes(normalized)) normalizedPaths.push(normalized);
  }
  normalizedPaths.sort();
  const repository = await repositoryId(resolvedRoot, config.repositoryId);
  const relativePaths = await enumerateFiles(resolvedRoot, normalizedPaths, errors);
  const prepared = await prepareFileEntries(resolvedRoot, relativePaths, include, exclude, errors);
  const sourceHashes: Record<string, string> = {};
  for (const entry of prepared.entries) if (entry.hash) sourceHashes[entry.relativePath] = entry.hash;
  const files = new Map(prepared.entries.map((entry) => [entry.relativePath, entry]));
  const targets: PreparedTarget[] = [];
  const diagnosticsByFile = new Map<string, string[]>();
  // Test selection is an AST rule, independent of the filename.  This keeps
  // fixtures and unconventional test filenames observable while the default
  // include pattern still admits production modules for context resolution.
  const parsedTests = prepared.parsed;

  for (const file of parsedTests) {
    const calls = callExpressions(file.ast);
    const diagnostics: string[] = [];
    const describes = describeCalls(calls, file.source, diagnostics);
    const tests = testCalls(calls, file.source, describes, diagnostics);
    if (tests.skipped > 0) diagnostics.push(`skipped tests: ${tests.skipped}`);
    if (diagnostics.length > 0) diagnosticsByFile.set(file.relativePath, diagnostics);
    if (tests.records.length === 0) continue;
    const occurrenceByIdentity = new Map<string, number>();
    const production = productionModule(file, files);
    for (const record of tests.records) {
      const identity = `${record.path.join("\u0000")}\u0001${record.title}`;
      const occurrence = (occurrenceByIdentity.get(identity) ?? 0) + 1;
      occurrenceByIdentity.set(identity, occurrence);
      const sibling = tests.records.find((candidate) => candidate.node.id() !== record.node.id());
      const ownSnippet = pickSnippet(record.node, file.source);
      const siblingSnippet = sibling ? pickSnippet(sibling.node, file.source, record.node) : null;
      let contextMode: ContextMode = production.file ? "focusprod" : "focus";
      let contextReason = production.reason;
      const folded = foldedSource(file.source, tests.records, record);
      let state = targetState(file.relativePath, record, folded, production.file);
      let questions = targetQuestions(definition, record, file.source, ownSnippet, siblingSnippet, folded);
      if (production.file && exceedsInputLimit(state, questions)) {
        contextMode = "focus";
        contextReason = "production_context_input_limit";
        state = targetState(file.relativePath, record, folded, null);
        questions = targetQuestions(definition, record, file.source, ownSnippet, siblingSnippet, folded);
      }
      let unjudgeableReason: string | undefined;
      if (exceedsInputLimit(state, questions)) {
        unjudgeableReason = "input_limit";
        contextReason = contextReason ?? "input_limit";
      }
      // Evidence describes the files a reviewer would need to validate the
      // proposition. It remains complete even when production text is omitted
      // from the transmitted state because of the input limit.
      const sources = evidenceSources(file.relativePath, sourceHashes[file.relativePath] ?? hashText(file.rawSource), production.file, sourceHashes);
      const fingerprint = targetFingerprint(definition, file.relativePath, record, occurrence);
      targets.push({
        fingerprint,
        aspect: definition.id,
        location: { file: file.relativePath, startLine: record.range.startLine, endLine: record.range.endLine },
        target: { path: record.path, name: record.title },
        contextMode,
        ...(contextReason ? { contextReason } : {}),
        inputHash: hash(state),
        subjectRevision: subjectRevision(definition.propositionVersion, sources),
        evidenceSources: sources,
        state,
        questions,
        controls: {
          own: ownSnippet ? "available" : "not_available",
          sibling: siblingSnippet ? "available" : "not_available",
        },
        ...(unjudgeableReason ? { unjudgeableReason } : {}),
      });
    }
  }
  const scopeFiles: ScopeFile[] = prepared.entries.map((entry) => ({
    file: entry.relativePath,
    status: entry.status,
    ...(entry.hash ? { hash: entry.hash } : {}),
    ...((entry.reason || diagnosticsByFile.has(entry.relativePath)) ? {
      reason: [entry.reason, ...(diagnosticsByFile.get(entry.relativePath) ?? [])].filter(Boolean).join("; "),
    } : {}),
  }));
  const scope: Scope = {
    repositoryId: repository,
    id: scopeId(repository, normalizedPaths, include, exclude),
    paths: normalizedPaths,
    include,
    exclude,
    languages: LANGUAGE_NAMES,
    selectionPolicy: "files@1",
    enumerationComplete: prepared.complete && !errors.some((error) =>
      error.startsWith("cannot enumerate") || error.startsWith("unsafe scope path")),
    files: scopeFiles,
  };
  return { scope, targets, sourceHashes, errors };
}
