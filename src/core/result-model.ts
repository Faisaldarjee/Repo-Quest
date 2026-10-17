/**
 * A command expressed as argv rather than a shell command line.
 *
 * The core package never executes this value. Consumers can pass the fields to
 * a process runner that explicitly uses `shell: false`.
 */
export interface SafeCommand {
  readonly executable: string;
  readonly args: readonly string[];
  /** A repository-relative working directory. */
  readonly cwd?: string;
  /** Maximum execution time requested by a caller. */
  readonly timeoutMs?: number;
}

export interface ValidationIssue {
  readonly path: string;
  readonly message: string;
}

export interface ValidationSuccess<T> {
  readonly valid: true;
  readonly value: T;
}

export interface ValidationFailure {
  readonly valid: false;
  readonly errors: readonly ValidationIssue[];
}

export type ValidationResult<T> = ValidationSuccess<T> | ValidationFailure;

const WINDOWS_ABSOLUTE_PATH = /^[A-Za-z]:[\\/]/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasNul(value: string): boolean {
  return value.includes("\u0000");
}

function isRepositoryRelativePath(value: string): boolean {
  if (value.length === 0 || value.startsWith("/") || value.startsWith("\\") || WINDOWS_ABSOLUTE_PATH.test(value)) {
    return false;
  }

  return !value.split(/[\\/]+/).some((part) => part === "..");
}

/**
 * Validate a command without interpreting or executing it.
 *
 * Shell metacharacters are allowed in arguments because they are ordinary
 * argument data when a caller uses a non-shell process API. NUL bytes,
 * ambiguous executables, absolute working directories, and traversal are
 * rejected here so the model stays portable and easy to sandbox.
 */
export function validateSafeCommand(input: unknown): ValidationResult<SafeCommand> {
  const errors: ValidationIssue[] = [];

  if (!isRecord(input)) {
    return { valid: false, errors: [{ path: "$", message: "expected a command object" }] };
  }

  const executable = input.executable;
  const args = input.args;
  const cwd = input.cwd;
  const timeoutMs = input.timeoutMs;

  if (typeof executable !== "string" || executable.trim().length === 0) {
    errors.push({ path: "$.executable", message: "must be a non-empty string" });
  } else if (/\s/.test(executable) || hasNul(executable)) {
    errors.push({ path: "$.executable", message: "must be one executable token without whitespace or NUL" });
  }

  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string" || hasNul(arg))) {
    errors.push({ path: "$.args", message: "must be an array of strings without NUL bytes" });
  }

  if (cwd !== undefined && (typeof cwd !== "string" || !isRepositoryRelativePath(cwd) || hasNul(cwd))) {
    errors.push({ path: "$.cwd", message: "must be a repository-relative path without traversal or NUL bytes" });
  }

  if (timeoutMs !== undefined && (typeof timeoutMs !== "number" || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 86_400_000)) {
    errors.push({ path: "$.timeoutMs", message: "must be an integer between 1 and 86400000" });
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return {
    valid: true,
    value: {
      executable: executable as string,
      args: Object.freeze([...(args as string[])]),
      ...(cwd === undefined ? {} : { cwd: cwd as string }),
      ...(timeoutMs === undefined ? {} : { timeoutMs: timeoutMs as number }),
    },
  };
}

export interface SafeCommandOptions {
  readonly cwd?: string;
  readonly timeoutMs?: number;
}

/** Construct an immutable command value after validating it. */
export function createSafeCommand(
  executable: string,
  args: readonly string[] = [],
  options: SafeCommandOptions = {},
): SafeCommand {
  const checked = validateSafeCommand({ executable, args, ...options });
  if (!checked.valid) {
    throw new TypeError(checked.errors.map((error) => `${error.path}: ${error.message}`).join("; "));
  }

  return Object.freeze(checked.value);
}

export type CommandStatus = "passed" | "failed" | "timed-out" | "blocked" | "error";

export interface CommandResult {
  readonly kind: "command";
  readonly command: SafeCommand;
  readonly status: CommandStatus;
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  readonly error?: string;
}

export interface CommandResultInput {
  readonly command: SafeCommand;
  readonly status: CommandStatus;
  readonly exitCode?: number | null;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly durationMs?: number;
  readonly error?: string;
}

/** Normalize a runner result into a serializable, shell-free result model. */
export function createCommandResult(input: CommandResultInput): CommandResult {
  const commandCheck = validateSafeCommand(input.command);
  if (!commandCheck.valid) {
    throw new TypeError(commandCheck.errors.map((error) => `${error.path}: ${error.message}`).join("; "));
  }
  if (!Number.isFinite(input.durationMs ?? 0) || (input.durationMs ?? 0) < 0) {
    throw new TypeError("durationMs must be a non-negative finite number");
  }

  const result: CommandResult = {
    kind: "command",
    command: commandCheck.value,
    status: input.status,
    exitCode: input.exitCode ?? null,
    stdout: input.stdout ?? "",
    stderr: input.stderr ?? "",
    durationMs: input.durationMs ?? 0,
    ...(input.error === undefined ? {} : { error: input.error }),
  };

  return Object.freeze(result);
}

export type VerificationOutcome = "passed" | "failed" | "inconclusive";

export interface VerificationCheck {
  readonly name: string;
  readonly outcome: VerificationOutcome;
  readonly detail?: string;
}

export interface VerificationResult {
  readonly kind: "verification";
  readonly outcome: VerificationOutcome;
  readonly summary: string;
  readonly checks: readonly VerificationCheck[];
  readonly commandResult?: CommandResult;
}

export interface VerificationResultInput {
  readonly outcome: VerificationOutcome;
  readonly summary?: string;
  readonly checks?: readonly VerificationCheck[];
  readonly commandResult?: CommandResult;
}

/** Create an immutable verification result suitable for mission evidence. */
export function createVerificationResult(input: VerificationResultInput): VerificationResult {
  const result: VerificationResult = {
    kind: "verification",
    outcome: input.outcome,
    summary: input.summary ?? "",
    checks: Object.freeze([...(input.checks ?? [])]),
    ...(input.commandResult === undefined ? {} : { commandResult: input.commandResult }),
  };

  return Object.freeze(result);
}

export type MissionEvidenceStage = "baseline" | "solver" | "verifier";

export interface MissionEvidence {
  readonly stage: MissionEvidenceStage;
  readonly result: CommandResult | VerificationResult;
  readonly note?: string;
}
