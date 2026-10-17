import { spawn } from "node:child_process";
import { relative, resolve, sep } from "node:path";
import {
  createCommandResult,
  createSafeCommand,
  type CommandResult,
  type SafeCommand,
  validateSafeCommand,
} from "./result-model.ts";

export interface CommandRunnerOptions {
  readonly repoRoot: string;
  readonly defaultTimeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly allowedExecutables?: ReadonlySet<string>;
  readonly env?: Readonly<Record<string, string>>;
}

const DEFAULT_ALLOWED_EXECUTABLES = new Set(["node", "npm", "npx", "pnpm", "yarn", "python", "pytest"]);
function redact(value: string): string {
  return value
    .replace(/(api[_-]?key|token|secret|password)\s*[=:]\s*[^\s\n]+/gi, (_match, key: string) => `${key}=[REDACTED]`)
    .replace(/Bearer\s+[A-Za-z0-9._~+\-/]+=*/gi, "Bearer [REDACTED]");
}

function withinRoot(root: string, candidate: string): boolean {
  const path = resolve(candidate);
  const rootPath = resolve(root);
  const distance = relative(rootPath, path);
  return distance === "" || (!distance.startsWith(`..${sep}`) && distance !== "..");
}

function boundedAppend(current: string, next: string, maxBytes: number): string {
  const remaining = Math.max(0, maxBytes - Buffer.byteLength(current, "utf8"));
  if (remaining === 0) return current;
  const chunk = Buffer.from(next, "utf8");
  if (chunk.byteLength <= remaining) return current + next;
  return current + chunk.subarray(0, remaining).toString("utf8") + "\n[output truncated]";
}

/** Execute an argv command without a shell in a bounded repository workspace. */
export function runSafeCommand(command: SafeCommand, options: CommandRunnerOptions): Promise<CommandResult> {
  const checked = validateSafeCommand(command);
  if (!checked.valid) {
    return Promise.resolve(
      createCommandResult({
        command: createSafeCommand("node"),
        status: "blocked",
        error: checked.errors.map((error) => `${error.path}: ${error.message}`).join("; "),
      }),
    );
  }

  const safeCommand = checked.value;
  const allowed = options.allowedExecutables ?? DEFAULT_ALLOWED_EXECUTABLES;
  if (!allowed.has(safeCommand.executable)) {
    return Promise.resolve(
      createCommandResult({
        command: safeCommand,
        status: "blocked",
        error: `Executable is not allow-listed: ${safeCommand.executable}`,
      }),
    );
  }

  const cwd = resolve(options.repoRoot, safeCommand.cwd ?? ".");
  if (!withinRoot(options.repoRoot, cwd)) {
    return Promise.resolve(
      createCommandResult({ command: safeCommand, status: "blocked", error: "Working directory escapes repository root" }),
    );
  }

  const timeoutMs = safeCommand.timeoutMs ?? options.defaultTimeoutMs ?? 15_000;
  const maxOutputBytes = options.maxOutputBytes ?? 32_000;
  const started = Date.now();

  return new Promise((resolveResult) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const child = spawn(safeCommand.executable, [...safeCommand.args], {
      cwd,
      shell: false,
      windowsHide: true,
      env: { ...process.env, ...options.env },
    });

    const finish = (result: CommandResult) => {
      if (settled) return;
      settled = true;
      resolveResult(result);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout = boundedAppend(stdout, chunk.toString(), maxOutputBytes);
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr = boundedAppend(stderr, chunk.toString(), maxOutputBytes);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      finish(
        createCommandResult({
          command: safeCommand,
          status: "error",
          stdout: redact(stdout),
          stderr: redact(stderr),
          durationMs: Date.now() - started,
          error: error.message,
        }),
      );
    });
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      finish(
        createCommandResult({
          command: safeCommand,
          status: timedOut ? "timed-out" : exitCode === 0 ? "passed" : "failed",
          exitCode,
          stdout: redact(stdout),
          stderr: redact(stderr),
          durationMs: Date.now() - started,
          ...(timedOut ? { error: `Command exceeded ${timeoutMs}ms` } : {}),
        }),
      );
    });
  });
}
