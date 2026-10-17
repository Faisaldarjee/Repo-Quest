import { cp, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { watch, type FSWatcher } from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import {
  readQuestManifest,
  runSafeCommand,
  scanRepository,
  type CommandResult,
  type QuestManifest,
  type QuestMission,
} from "../core/index.ts";

export type PlayWatcherMode = "fs.watch" | "polling";

export interface PlaySessionOptions {
  /** The repository to copy before a play session starts. */
  readonly repositoryRoot: string;
  /** The quest manifest used to describe and verify the copied repository. */
  readonly questManifestPath: string;
  /** Polling interval used when recursive fs.watch is unavailable. */
  readonly pollIntervalMs?: number;
  /** Maximum number of activity and file-change events retained in memory. */
  readonly maxActivity?: number;
}

export interface FileChangeEvent {
  readonly kind: "file-change";
  readonly event: "change" | "rename";
  readonly path: string;
  readonly at: string;
}

export interface ActivityEvent {
  readonly kind: "activity" | "file-change";
  readonly message?: string;
  readonly event?: "change" | "rename";
  readonly path?: string;
  readonly at: string;
}

export interface PlayProject {
  readonly name: string;
  readonly root: string;
  readonly repositoryRoot: string;
  readonly workspaceRoot: string;
  readonly questManifestPath: string;
  readonly scan: Awaited<ReturnType<typeof scanRepository>>;
}

export interface PlayMissionView extends QuestMission {
  readonly status: "completed" | "available" | "locked";
}

export interface PlayState {
  readonly project: PlayProject;
  readonly quest: QuestManifest;
  readonly manifest: Pick<QuestManifest, "id" | "title" | "description">;
  readonly scan: {
    readonly files: number;
    readonly tests: number;
    readonly routes: number;
    readonly symbols: number;
    readonly packageScripts: Readonly<Record<string, string>>;
  };
  readonly missions: readonly PlayMissionView[];
  readonly progress: { readonly completed: number; readonly total: number };
  readonly activity: readonly string[];
  readonly activityEvents: readonly ActivityEvent[];
  readonly fileChanges: readonly FileChangeEvent[];
  /** Compatibility alias for clients that call these changes. */
  readonly changes: readonly FileChangeEvent[];
  readonly watcher: { readonly mode: PlayWatcherMode; readonly polling: boolean };
  readonly analytics: readonly MissionAnalytics[];
  readonly workspaceRoot: string;
}

export interface MissionAnalytics {
  readonly missionId: string;
  readonly attempts: number;
  readonly passes: number;
  readonly failures: number;
  readonly totalDurationMs: number;
  readonly lastStatus: "passed" | "failed";
}

export interface MissionVerification {
  readonly passed: boolean;
  readonly missionId: string;
  /** The final configured command result, retained for existing clients. */
  readonly result: CommandResult;
  readonly results: Readonly<Partial<Record<"baseline" | "solver" | "verifier", CommandResult>>>;
}

export interface PlaySession {
  readonly repositoryRoot: string;
  readonly questManifestPath: string;
  readonly workspaceRoot: string;
  readonly watcherMode: PlayWatcherMode;
  readonly manifest: QuestManifest;
  getProject(): Promise<PlayProject>;
  getQuest(): QuestManifest;
  getState(): Promise<PlayState>;
  verifyMission(missionId: string): Promise<MissionVerification>;
  reset(): Promise<void>;
  dispose(): Promise<void>;
}

type ValidationStage = "baseline" | "solver" | "verifier";

const VALIDATION_STAGES: readonly ValidationStage[] = ["baseline", "solver", "verifier"];
const DEFAULT_POLL_INTERVAL_MS = 250;
const DEFAULT_MAX_ACTIVITY = 40;
const IGNORED_WATCH_DIRECTORIES = new Set([".git", "node_modules", ".repoquest"]);

function assertPositiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return value;
}

function portablePath(value: string): string {
  return value.split("\\").join("/");
}

function isInside(root: string, candidate: string): boolean {
  const rootPath = resolve(root);
  const candidatePath = resolve(candidate);
  const distance = relative(rootPath, candidatePath);
  return distance === "" || (!distance.startsWith(`..${sep}`) && distance !== "..");
}

async function copyRepository(source: string): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), "repoquest-play-"));
  try {
    await cp(source, workspace, { recursive: true, force: true });
    return workspace;
  } catch (error) {
    await rm(workspace, { recursive: true, force: true });
    throw error;
  }
}

async function snapshotFiles(root: string): Promise<Map<string, string>> {
  const result = new Map<string, string>();

  async function visit(directory: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.isDirectory() && IGNORED_WATCH_DIRECTORIES.has(entry.name)) continue;
      const absolutePath = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(absolutePath);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        const details = await stat(absolutePath);
        result.set(portablePath(relative(root, absolutePath)), `${details.mtimeMs}:${details.size}`);
      } catch {
        // A file can disappear between directory enumeration and stat.
      }
    }
  }

  await visit(root);
  return result;
}

class LocalPlaySession implements PlaySession {
  public readonly repositoryRoot: string;
  public readonly questManifestPath: string;
  public workspaceRoot: string;
  public manifest: QuestManifest;

  private readonly pollIntervalMs: number;
  private readonly maxActivity: number;
  private watcher: FSWatcher | undefined;
  private pollTimer: NodeJS.Timeout | undefined;
  private pollInFlight = false;
  private disposed = false;
  private watcherModeValue: PlayWatcherMode = "polling";
  private readonly passed = new Set<string>();
  private readonly analytics = new Map<string, { attempts: number; passes: number; failures: number; totalDurationMs: number; lastStatus: "passed" | "failed" }>();
  private activityMessages: string[] = [];
  private activityEvents: ActivityEvent[] = [];
  private fileChanges: FileChangeEvent[] = [];
  private previousSnapshot = new Map<string, string>();

  private constructor(options: PlaySessionOptions, manifest: QuestManifest, workspaceRoot: string) {
    this.repositoryRoot = resolve(options.repositoryRoot);
    this.questManifestPath = resolve(options.questManifestPath);
    this.manifest = manifest;
    this.workspaceRoot = workspaceRoot;
    this.pollIntervalMs = assertPositiveInteger(options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS, "pollIntervalMs");
    this.maxActivity = assertPositiveInteger(options.maxActivity ?? DEFAULT_MAX_ACTIVITY, "maxActivity");
  }

  public static async create(options: PlaySessionOptions): Promise<LocalPlaySession> {
    const repositoryRoot = resolve(options.repositoryRoot);
    const questManifestPath = resolve(options.questManifestPath);
    assertPositiveInteger(options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS, "pollIntervalMs");
    assertPositiveInteger(options.maxActivity ?? DEFAULT_MAX_ACTIVITY, "maxActivity");
    const repositoryDetails = await stat(repositoryRoot);
    if (!repositoryDetails.isDirectory()) throw new TypeError("repositoryRoot must be a directory");
    const manifest = await readQuestManifest(questManifestPath);
    const workspaceRoot = await copyRepository(repositoryRoot);
    const session = new LocalPlaySession({ ...options, repositoryRoot, questManifestPath }, manifest, workspaceRoot);
    await session.startWatching();
    session.addActivity("Disposable play workspace prepared");
    return session;
  }

  public get watcherMode(): PlayWatcherMode {
    return this.watcherModeValue;
  }

  public getQuest(): QuestManifest {
    return this.manifest;
  }

  public async getProject(): Promise<PlayProject> {
    return {
      name: basename(this.repositoryRoot),
      root: this.repositoryRoot,
      repositoryRoot: this.repositoryRoot,
      workspaceRoot: this.workspaceRoot,
      questManifestPath: this.questManifestPath,
      scan: await scanRepository(this.workspaceRoot),
    };
  }

  public async getState(): Promise<PlayState> {
    this.assertActive();
    // Poll once on demand so API consumers see a change immediately even when
    // the platform cannot provide recursive fs.watch notifications.
    if (this.watcherModeValue === "polling") await this.pollOnce();
    const [project] = await Promise.all([this.getProject()]);
    const order = this.manifest.missions.map((mission) => mission.id);
    const missions = this.manifest.missions.map((mission, index): PlayMissionView => {
      const previousComplete = index === 0 || this.passed.has(order[index - 1] ?? "");
      const status = this.passed.has(mission.id) ? "completed" : previousComplete ? "available" : "locked";
      return { ...mission, status };
    });

    return {
      project,
      quest: this.manifest,
      manifest: { id: this.manifest.id, title: this.manifest.title, description: this.manifest.description },
      scan: {
        files: project.scan.files.length,
        tests: project.scan.tests.length,
        routes: project.scan.likelyRoutes.length,
        symbols: project.scan.exportedSymbols.length,
        packageScripts: project.scan.packageScripts,
      },
      missions,
      progress: { completed: this.passed.size, total: this.manifest.missions.length },
      activity: Object.freeze([...this.activityMessages]),
      activityEvents: Object.freeze([...this.activityEvents]),
      fileChanges: Object.freeze([...this.fileChanges]),
      changes: Object.freeze([...this.fileChanges]),
      watcher: { mode: this.watcherModeValue, polling: this.watcherModeValue === "polling" },
      analytics: Object.freeze([...this.analytics.entries()].map(([missionId, value]) => Object.freeze({ missionId, ...value }))),
      workspaceRoot: this.workspaceRoot,
    };
  }

  public async verifyMission(missionId: string): Promise<MissionVerification> {
    this.assertActive();
    const startedAt = Date.now();
    const normalizedId = typeof missionId === "string" ? missionId.trim() : "";
    if (normalizedId.length === 0) throw new TypeError("missionId is required");
    const mission = this.manifest.missions.find((candidate) => candidate.id === normalizedId);
    if (mission === undefined) throw new Error(`Unknown mission: ${normalizedId}`);
    const validation = mission.validation;
    if (validation === undefined) throw new Error("This mission has no executable validation plan");

    const results: Partial<Record<ValidationStage, CommandResult>> = {};
    let finalResult: CommandResult | undefined;
    let passed = true;
    let commandCount = 0;
    for (const stage of VALIDATION_STAGES) {
      const command = validation[stage];
      if (command === undefined) continue;
      commandCount += 1;
      const result = await runSafeCommand(command, {
        repoRoot: this.workspaceRoot,
        defaultTimeoutMs: 15_000,
      });
      results[stage] = result;
      finalResult = result;
      if (result.status !== "passed") passed = false;
    }

    if (commandCount === 0 || finalResult === undefined) {
      throw new Error("This mission has no executable validation commands");
    }

    if (passed) {
      this.passed.add(normalizedId);
      this.addActivity(`${normalizedId} verified with a real command run`);
    } else {
      this.addActivity(`${normalizedId} failed; captured command output is available`);
    }

    const current = this.analytics.get(normalizedId) ?? { attempts: 0, passes: 0, failures: 0, totalDurationMs: 0, lastStatus: passed ? "passed" as const : "failed" as const };
    this.analytics.set(normalizedId, {
      attempts: current.attempts + 1,
      passes: current.passes + (passed ? 1 : 0),
      failures: current.failures + (passed ? 0 : 1),
      totalDurationMs: current.totalDurationMs + (Date.now() - startedAt),
      lastStatus: passed ? "passed" : "failed",
    });

    return { passed, missionId: normalizedId, result: finalResult, results };
  }

  public async reset(): Promise<void> {
    this.assertActive();
    const manifest = await readQuestManifest(this.questManifestPath);
    await this.stopWatching();
    const oldWorkspace = this.workspaceRoot;
    let nextWorkspace: string;
    try {
      nextWorkspace = await copyRepository(this.repositoryRoot);
    } catch (error) {
      await this.startWatching();
      throw error;
    }
    this.workspaceRoot = nextWorkspace;
    this.manifest = manifest;
    this.passed.clear();
    this.analytics.clear();
    this.activityMessages = [];
    this.activityEvents = [];
    this.fileChanges = [];
    this.previousSnapshot = new Map();
    await rm(oldWorkspace, { recursive: true, force: true });
    await this.startWatching();
    this.addActivity("Play workspace reset to the repository checkout");
  }

  public async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await this.stopWatching();
    await rm(this.workspaceRoot, { recursive: true, force: true });
  }

  private assertActive(): void {
    if (this.disposed) throw new Error("Play session has been disposed");
  }

  private addActivity(message: string): void {
    const at = new Date().toISOString();
    this.activityMessages.unshift(message);
    this.activityMessages.splice(this.maxActivity);
    this.activityEvents.unshift({ kind: "activity", message, at });
    this.activityEvents.splice(this.maxActivity);
  }

  private addFileChange(event: "change" | "rename", filename: string): void {
    if (this.disposed) return;
    const absolutePath = resolve(this.workspaceRoot, filename);
    if (!isInside(this.workspaceRoot, absolutePath)) return;
    const path = portablePath(relative(this.workspaceRoot, absolutePath));
    if (path === "" || path.split("/").some((part) => IGNORED_WATCH_DIRECTORIES.has(part))) return;
    const at = new Date().toISOString();
    const fileChange: FileChangeEvent = { kind: "file-change", event, path, at };
    this.fileChanges.unshift(fileChange);
    this.fileChanges.splice(this.maxActivity);
    this.activityEvents.unshift({ ...fileChange });
    this.activityEvents.splice(this.maxActivity);
    this.activityMessages.unshift(`File ${event === "rename" ? "added or removed" : "changed"}: ${path}`);
    this.activityMessages.splice(this.maxActivity);
  }

  private async startWatching(): Promise<void> {
    this.previousSnapshot = await snapshotFiles(this.repositoryRoot);
    try {
      const candidate = watch(this.repositoryRoot, { recursive: true }, (event, filename) => {
        if (filename === null) return;
        this.syncSourceChange(event === "rename" ? "rename" : "change", filename.toString()).catch(() => undefined);
      });
      candidate.on("error", () => {
        this.startPolling().catch(() => undefined);
      });
      this.watcher = candidate;
      this.watcherModeValue = "fs.watch";
    } catch {
      await this.startPolling();
    }
  }

  private async startPolling(): Promise<void> {
    if (this.disposed) return;
    if (this.watcher !== undefined) {
      this.watcher.close();
      this.watcher = undefined;
    }
    if (this.pollTimer !== undefined) return;
    this.watcherModeValue = "polling";
    this.pollTimer = setInterval(() => {
      this.pollOnce().catch(() => undefined);
    }, this.pollIntervalMs);
    this.pollTimer.unref();
  }

  private async pollOnce(): Promise<void> {
    if (this.pollInFlight || this.disposed) return;
    this.pollInFlight = true;
    try {
        const next = await snapshotFiles(this.repositoryRoot);
      const paths = new Set([...this.previousSnapshot.keys(), ...next.keys()]);
      for (const path of paths) {
        const before = this.previousSnapshot.get(path);
        const after = next.get(path);
        if (before === after) continue;
        const event = after === undefined || before === undefined ? "rename" : "change";
        await this.syncSourceChange(event, path);
      }
      this.previousSnapshot = next;
    } finally {
      this.pollInFlight = false;
    }
  }

  private async syncSourceChange(event: "change" | "rename", filename: string): Promise<void> {
    const normalized = portablePath(filename);
    const sourcePath = resolve(this.repositoryRoot, normalized);
    const workspacePath = resolve(this.workspaceRoot, normalized);
    if (!isInside(this.repositoryRoot, sourcePath) || !isInside(this.workspaceRoot, workspacePath)) return;
    if (normalized === "" || normalized.split("/").some((part) => IGNORED_WATCH_DIRECTORIES.has(part))) return;
    let copied = false;
    for (let attempt = 0; attempt < 4 && !copied; attempt += 1) {
      try {
        const details = await stat(sourcePath);
        if (details.isDirectory()) {
          await cp(sourcePath, workspacePath, { recursive: true, force: true });
        } else {
          await cp(sourcePath, workspacePath, { force: true });
        }
        copied = true;
      } catch {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
      }
    }
    if (!copied) {
      await rm(workspacePath, { recursive: true, force: true });
      if (event === "change") return;
    }
    this.addFileChange(event, normalized);
  }

  private async stopWatching(): Promise<void> {
    if (this.watcher !== undefined) {
      this.watcher.close();
      this.watcher = undefined;
    }
    if (this.pollTimer !== undefined) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
  }
}

/** Create a local play session and copy the source repository into a disposable workspace. */
export async function createPlaySession(options: PlaySessionOptions): Promise<PlaySession>;
/** Positional convenience form for small integrations and tests. */
export async function createPlaySession(repositoryRoot: string, questManifestPath: string, options?: Omit<PlaySessionOptions, "repositoryRoot" | "questManifestPath">): Promise<PlaySession>;
export async function createPlaySession(
  optionsOrRepositoryRoot: PlaySessionOptions | string,
  questManifestPath?: string,
  options: Omit<PlaySessionOptions, "repositoryRoot" | "questManifestPath"> = {},
): Promise<PlaySession> {
  const normalized: PlaySessionOptions =
    typeof optionsOrRepositoryRoot === "string"
      ? { ...options, repositoryRoot: optionsOrRepositoryRoot, questManifestPath: questManifestPath ?? "" }
      : optionsOrRepositoryRoot;
  if (typeof normalized.questManifestPath !== "string" || normalized.questManifestPath.trim().length === 0) {
    throw new TypeError("questManifestPath is required");
  }
  return LocalPlaySession.create(normalized);
}
