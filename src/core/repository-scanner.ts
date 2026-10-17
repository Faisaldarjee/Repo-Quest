import { readdir, stat } from "node:fs/promises";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const DEFAULT_IGNORED_DIRECTORIES = ["node_modules", ".git", ".repoquest"] as const;
const TEXT_EXTENSIONS = new Set([
  ".cjs",
  ".cts",
  ".go",
  ".java",
  ".js",
  ".jsx",
  ".json",
  ".mjs",
  ".mts",
  ".php",
  ".py",
  ".rb",
  ".rs",
  ".svelte",
  ".ts",
  ".tsx",
  ".vue",
]);

export interface RepositoryScanOptions {
  readonly ignoreDirectories?: readonly string[];
  readonly maxTextFileBytes?: number;
}

export interface RepositoryScanResult {
  /** Every regular file below the repository root, as sorted POSIX paths. */
  readonly files: readonly string[];
  /** Scripts merged from package.json files; root scripts win name collisions. */
  readonly packageScripts: Readonly<Record<string, string>>;
  /** Route-like path literals found with conservative regular expressions. */
  readonly likelyRoutes: readonly string[];
  /** Files that look like tests by path or common test API usage. */
  readonly tests: readonly string[];
  /** Unique exported names found in source files. */
  readonly exportedSymbols: readonly string[];
}

interface ScannedFile {
  readonly absolutePath: string;
  readonly relativePath: string;
  readonly sizeBytes: number;
}

interface ScanAccumulator {
  readonly files: ScannedFile[];
  readonly ignoredDirectories: ReadonlySet<string>;
  readonly maxTextFileBytes: number;
}

function toPortablePath(value: string): string {
  return value.split("\\").join("/");
}

function isTextFile(file: ScannedFile): boolean {
  const lower = file.relativePath.toLowerCase();
  const basename = lower.slice(lower.lastIndexOf("/") + 1);
  const dot = basename.lastIndexOf(".");
  return basename === "package.json" || (dot >= 0 && TEXT_EXTENSIONS.has(basename.slice(dot)));
}

function isTestPath(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return (
    /(^|\/)(__tests__|tests?|specs?)(\/|$)/.test(lower) ||
    /(^|\/)[^/]+\.(test|spec)\.[^/]+$/.test(lower) ||
    /(^|\/)test[^/]*\.(?:[cm]?[jt]sx?|vue|py|rb|go)$/.test(lower)
  );
}

function readText(file: ScannedFile, maxTextFileBytes: number, read: (path: string, encoding: "utf8") => string): string | undefined {
  if (!isTextFile(file) || file.sizeBytes > maxTextFileBytes) {
    return undefined;
  }
  try {
    const content = read(file.absolutePath, "utf8");
    // Binary data is not useful to regex scanning and can create noisy matches.
    return content.includes("\u0000") ? undefined : content;
  } catch {
    return undefined;
  }
}

function collectAsync(root: string, accumulator: ScanAccumulator): Promise<void> {
  return readdir(root, { withFileTypes: true }).then(async (entries) => {
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.isDirectory() && accumulator.ignoredDirectories.has(entry.name)) {
        continue;
      }
      const absolutePath = join(root, entry.name);
      if (entry.isDirectory()) {
        await collectAsync(absolutePath, accumulator);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      const details = await stat(absolutePath);
      accumulator.files.push({
        absolutePath,
        relativePath: toPortablePath(relative(accumulatorRoot(accumulator), absolutePath)),
        sizeBytes: details.size,
      });
    }
  });
}

// The accumulator is deliberately kept internal; this helper avoids passing
// the root through every recursive call while retaining a plain data shape.
const roots = new WeakMap<object, string>();
function accumulatorRoot(accumulator: ScanAccumulator): string {
  const root = roots.get(accumulator);
  if (root === undefined) {
    throw new Error("scanner root was not initialized");
  }
  return root;
}

function collectSync(root: string, accumulator: ScanAccumulator): void {
  const entries = readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (entry.isDirectory() && accumulator.ignoredDirectories.has(entry.name)) {
      continue;
    }
    const absolutePath = join(root, entry.name);
    if (entry.isDirectory()) {
      collectSync(absolutePath, accumulator);
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    const details = statSync(absolutePath);
    accumulator.files.push({
      absolutePath,
      relativePath: toPortablePath(relative(accumulatorRoot(accumulator), absolutePath)),
      sizeBytes: details.size,
    });
  }
}

function makeAccumulator(root: string, options: RepositoryScanOptions): ScanAccumulator {
  const maxTextFileBytes = options.maxTextFileBytes ?? 1_048_576;
  if (!Number.isInteger(maxTextFileBytes) || maxTextFileBytes < 1) {
    throw new TypeError("maxTextFileBytes must be a positive integer");
  }
  const accumulator: ScanAccumulator = {
    files: [],
    ignoredDirectories: new Set([...DEFAULT_IGNORED_DIRECTORIES, ...(options.ignoreDirectories ?? [])]),
    maxTextFileBytes,
  };
  roots.set(accumulator, root);
  return accumulator;
}

function extractRoutes(content: string): string[] {
  const routes = new Set<string>();
  const patterns = [
    /\b(?:app|router|server|api|route)\s*\.\s*(?:get|post|put|patch|delete|options|head|use)\s*\(\s*["'`]([^"'`]+)["'`]/gi,
    /@(?:Get|Post|Put|Patch|Delete|Options|Head)\s*\(\s*["'`]([^"'`]+)["'`]/g,
    /\b(?:route|path|url)\s*[:=]\s*["'`](\/[^"'`]*)["'`]/gi,
  ];
  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) {
      const route = match[1]?.trim();
      if (route !== undefined && route.length > 0) {
        routes.add(route);
      }
    }
  }
  return [...routes];
}

function extractExportedSymbols(content: string): string[] {
  const symbols = new Set<string>();
  const declarations = /\bexport\s+(?:declare\s+)?(?:async\s+)?(?:function|class|const|let|var|enum|interface|type)\s+([A-Za-z_$][\w$]*)/g;
  for (const match of content.matchAll(declarations)) {
    if (match[1] !== undefined) symbols.add(match[1]);
  }

  const defaults = /\bexport\s+default(?:\s+(?:async\s+)?(?:function|class)\s+([A-Za-z_$][\w$]*))?/g;
  for (const match of content.matchAll(defaults)) {
    symbols.add(match[1] ?? "default");
  }

  const lists = /\bexport\s*{([^}]+)}/g;
  for (const match of content.matchAll(lists)) {
    for (const entry of (match[1] ?? "").split(",")) {
      const name = entry.trim().split(/\s+as\s+/i).pop()?.trim();
      if (name !== undefined && /^[A-Za-z_$][\w$]*$/.test(name)) symbols.add(name);
    }
  }

  const commonJs = /\b(?:module\.exports|exports)\.([A-Za-z_$][\w$]*)\s*=/g;
  for (const match of content.matchAll(commonJs)) {
    if (match[1] !== undefined) symbols.add(match[1]);
  }

  return [...symbols];
}

function looksLikeTestContent(content: string): boolean {
  return /\b(?:describe|suite|it|test)\s*\(/.test(content);
}

function analyze(accumulator: ScanAccumulator, read: (path: string, encoding: "utf8") => string): RepositoryScanResult {
  const files = accumulator.files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  const packageScripts: Record<string, string> = {};
  const routes = new Set<string>();
  const exportedSymbols = new Set<string>();
  const tests = new Set<string>();

  for (const file of files) {
    const content = readText(file, accumulator.maxTextFileBytes, read);
    if (content === undefined) {
      if (isTestPath(file.relativePath)) tests.add(file.relativePath);
      continue;
    }

    if (file.relativePath.toLowerCase().endsWith("package.json")) {
      try {
        const parsed: unknown = JSON.parse(content);
        if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
          const scripts = (parsed as Record<string, unknown>).scripts;
          if (typeof scripts === "object" && scripts !== null && !Array.isArray(scripts)) {
            for (const [name, value] of Object.entries(scripts as Record<string, unknown>)) {
              if (typeof value === "string" && !(name in packageScripts)) packageScripts[name] = value;
            }
          }
        }
      } catch {
        // A malformed package file remains visible in files but contributes no metadata.
      }
    }

    if (isTestPath(file.relativePath) || looksLikeTestContent(content)) tests.add(file.relativePath);
    for (const route of extractRoutes(content)) routes.add(route);
    for (const symbol of extractExportedSymbols(content)) exportedSymbols.add(symbol);
  }

  return Object.freeze({
    files: Object.freeze(files.map((file) => file.relativePath)),
    packageScripts: Object.freeze({ ...packageScripts }),
    likelyRoutes: Object.freeze([...routes].sort()),
    tests: Object.freeze([...tests].sort()),
    exportedSymbols: Object.freeze([...exportedSymbols].sort()),
  });
}

async function ensureDirectory(root: string): Promise<void> {
  const details = await stat(root);
  if (!details.isDirectory()) throw new TypeError("repository root must be a directory");
}

function ensureDirectorySync(root: string): void {
  if (!statSync(root).isDirectory()) throw new TypeError("repository root must be a directory");
}

/** Scan a repository without running commands or loading a parser. */
export async function scanRepository(repositoryRoot: string, options: RepositoryScanOptions = {}): Promise<RepositoryScanResult> {
  const root = resolve(repositoryRoot);
  await ensureDirectory(root);
  const accumulator = makeAccumulator(root, options);
  await collectAsync(root, accumulator);
  return analyze(accumulator, (path, encoding) => readFileSync(path, encoding));
}

/** Synchronous counterpart useful to CLI callers and deterministic unit tests. */
export function scanRepositorySync(repositoryRoot: string, options: RepositoryScanOptions = {}): RepositoryScanResult {
  const root = resolve(repositoryRoot);
  ensureDirectorySync(root);
  const accumulator = makeAccumulator(root, options);
  collectSync(root, accumulator);
  return analyze(accumulator, (path, encoding) => readFileSync(path, encoding));
}
