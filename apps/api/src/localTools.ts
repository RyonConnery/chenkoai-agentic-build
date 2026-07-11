import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  normalizeToolExecuteRequest,
  type LocalToolDefinition,
  type DataDocument,
  type ToolExecuteRequest,
  type ToolExecutionResult,
} from "@chenkoai/agent-core";
import type { DataStore } from "./dataStore.js";
import type { EmbeddingProviderAdapter } from "./embeddingProvider.js";
import type { ToolPermissionStore } from "./toolPermissions.js";

const defaultWorkspaceRoot = process.cwd();
const textFileExtensions = new Set([
  ".c",
  ".cpp",
  ".cs",
  ".css",
  ".env",
  ".example",
  ".h",
  ".html",
  ".js",
  ".json",
  ".jsx",
  ".md",
  ".mjs",
  ".py",
  ".rs",
  ".sql",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".yml",
  ".yaml",
]);

const lowValueDirectoryNames = new Set([
  ".git",
  ".next",
  ".tauri",
  "build",
  "dist",
  "node_modules",
  "out",
  "target",
  "__pycache__",
]);

const highValueEntryNames = new Set([
  "apps",
  "crates",
  "docs",
  "infra",
  "packages",
  "scripts",
  "services",
  "README.md",
  "package.json",
  "Cargo.toml",
  "tsconfig.base.json",
]);
const projectCheckTargets = new Set(["api", "desktop", "all"]);
const developmentOpenApps = new Set(["vscode", "default", "unreal"]);
const developmentTaskNames = new Set([
  "api_check",
  "desktop_check",
  "agent_core_check",
  "all_checks",
  "api_build",
  "desktop_build",
  "desktop_installer_build",
  "rust_native_check",
]);

type DevelopmentTaskDefinition = {
  task: string;
  description: string;
  program: string;
  args: string[];
  timeoutMs: number;
};

type LocalToolRegistryOptions = {
  workspaceRoot?: string;
  dataStore?: DataStore;
  embeddingProvider?: EmbeddingProviderAdapter;
};

export class LocalToolRegistry {
  readonly #workspaceRoot: string;
  readonly #permissionStore: ToolPermissionStore;
  readonly #dataStore?: DataStore;
  readonly #embeddingProvider?: EmbeddingProviderAdapter;

  constructor(
    permissionStore: ToolPermissionStore,
    options: LocalToolRegistryOptions = {},
  ) {
    this.#workspaceRoot = path.resolve(
      options.workspaceRoot ?? process.env.CHENKOAI_WORKSPACE_ROOT ?? defaultWorkspaceRoot,
    );
    this.#permissionStore = permissionStore;
    this.#dataStore = options.dataStore;
    this.#embeddingProvider = options.embeddingProvider;
  }

  list(): LocalToolDefinition[] {
    return [
      {
        name: "workspace.list_files",
        description: "List files and folders inside the configured ChenkoAI workspace.",
        destructive: false,
        requiresApproval: false,
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Workspace-relative folder path." },
          },
        },
      },
      {
        name: "workspace.read_text_file",
        description: "Read a UTF-8 text file inside the configured ChenkoAI workspace.",
        destructive: false,
        requiresApproval: false,
        inputSchema: {
          type: "object",
          required: ["path"],
          properties: {
            path: { type: "string", description: "Workspace-relative file path." },
            maxCharacters: {
              type: "number",
              description: "Maximum characters to return. Defaults to 12000.",
            },
          },
        },
      },
      {
        name: "workspace.write_text_file",
        description: "Write a UTF-8 text file inside the configured ChenkoAI workspace.",
        destructive: true,
        requiresApproval: true,
        inputSchema: {
          type: "object",
          required: ["path", "content"],
          properties: {
            path: { type: "string", description: "Workspace-relative file path." },
            content: { type: "string", description: "Text content to write." },
            overwrite: {
              type: "boolean",
              description: "Allow replacing an existing file. Defaults to false.",
            },
          },
        },
      },
      {
        name: "workspace.run_project_check",
        description:
          "Run an allowlisted ChenkoAI project check command and capture the result.",
        destructive: false,
        requiresApproval: true,
        inputSchema: {
          type: "object",
          required: ["target"],
          properties: {
            target: {
              type: "string",
              enum: ["api", "desktop", "all"],
              description: "Check target to run.",
            },
          },
        },
      },
      {
        name: "workspace.git_status",
        description: "Read the current Git status for the configured workspace.",
        destructive: false,
        requiresApproval: false,
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "workspace.git_diff",
        description: "Read the current Git diff for the configured workspace.",
        destructive: false,
        requiresApproval: false,
        inputSchema: {
          type: "object",
          properties: {
            maxCharacters: {
              type: "number",
              description: "Maximum diff characters to return. Defaults to 12000.",
            },
          },
        },
      },
      {
        name: "workspace.detect_development_tools",
        description:
          "Detect installed development tools and project files for IDE, engine, and build workflows.",
        destructive: false,
        requiresApproval: false,
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "workspace.open_development_target",
        description:
          "Open an approved workspace file, folder, or engine project in VS Code, the OS default app, or Unreal.",
        destructive: false,
        requiresApproval: true,
        inputSchema: {
          type: "object",
          required: ["app", "path"],
          properties: {
            app: {
              type: "string",
              enum: ["vscode", "default", "unreal"],
              description: "Development application to open.",
            },
            path: {
              type: "string",
              description: "Workspace-relative file, folder, or .uproject path.",
            },
            line: {
              type: "number",
              description: "Optional 1-based line number for VS Code file opens.",
            },
          },
        },
      },
      {
        name: "workspace.run_dev_task",
        description:
          "Run an approved allowlisted development task such as checks, builds, installer builds, or Rust validation.",
        destructive: false,
        requiresApproval: true,
        inputSchema: {
          type: "object",
          required: ["task"],
          properties: {
            task: {
              type: "string",
              enum: [...developmentTaskNames],
              description: "Allowlisted development task to run.",
            },
          },
        },
      },
      {
        name: "workspace.ingest_selected_content",
        description:
          "Store selected user-approved content as durable ChenkoAI memory, chunk it, embed it, and return retrieval evidence.",
        destructive: false,
        requiresApproval: true,
        inputSchema: {
          type: "object",
          required: ["datasetName", "title", "text"],
          properties: {
            datasetName: {
              type: "string",
              description: "Dataset where the selected content should be stored.",
            },
            title: {
              type: "string",
              description: "Document title for the selected content.",
            },
            text: {
              type: "string",
              description: "Selected content to store as durable memory.",
            },
            sourceType: {
              type: "string",
              enum: ["manual", "file", "url", "api"],
              description: "Source category. Defaults to manual.",
            },
            sourceUri: {
              type: "string",
              description: "Optional source reference, file, URL, or tool identifier.",
            },
            evaluationQuery: {
              type: "string",
              description: "Optional query used to verify retrieval after ingestion.",
            },
          },
        },
      },
    ];
  }

  async execute(input: ToolExecuteRequest): Promise<ToolExecutionResult> {
    const request = normalizeToolExecuteRequest(input);

    try {
      validateToolInput(request);
      const permissionResult = await this.#ensurePermission(request);
      if (permissionResult) {
        return permissionResult;
      }

      if (request.name === "workspace.list_files") {
        return {
          name: request.name,
          ok: true,
          output: await this.#listFiles(readString(request.input.path, ".")),
        };
      }

      if (request.name === "workspace.read_text_file") {
        return {
          name: request.name,
          ok: true,
          output: await this.#readTextFile(
            readString(request.input.path),
            readNumber(request.input.maxCharacters, 12_000),
          ),
        };
      }

      if (request.name === "workspace.write_text_file") {
        return {
          name: request.name,
          ok: true,
          output: await this.#writeTextFile(
            readString(request.input.path),
            readString(request.input.content),
            readBoolean(request.input.overwrite, false),
          ),
        };
      }

      if (request.name === "workspace.run_project_check") {
        return {
          name: request.name,
          ok: true,
          output: await this.#runProjectCheck(readProjectCheckTarget(request.input.target)),
        };
      }

      if (request.name === "workspace.git_status") {
        return {
          name: request.name,
          ok: true,
          output: await this.#gitStatus(),
        };
      }

      if (request.name === "workspace.git_diff") {
        return {
          name: request.name,
          ok: true,
          output: await this.#gitDiff(readNumber(request.input.maxCharacters, 12_000)),
        };
      }

      if (request.name === "workspace.detect_development_tools") {
        return {
          name: request.name,
          ok: true,
          output: await this.#detectDevelopmentTools(),
        };
      }

      if (request.name === "workspace.open_development_target") {
        return {
          name: request.name,
          ok: true,
          output: await this.#openDevelopmentTarget(
            readDevelopmentOpenApp(request.input.app),
            readString(request.input.path),
            readNumber(request.input.line, 0),
          ),
        };
      }

      if (request.name === "workspace.run_dev_task") {
        return {
          name: request.name,
          ok: true,
          output: await this.#runDevelopmentTask(readDevelopmentTaskName(request.input.task)),
        };
      }

      if (request.name === "workspace.ingest_selected_content") {
        return {
          name: request.name,
          ok: true,
          output: await this.#ingestSelectedContent({
            datasetName: readString(request.input.datasetName),
            title: readString(request.input.title),
            text: readString(request.input.text),
            sourceType: readDataSourceType(request.input.sourceType, "manual"),
            sourceUri: readOptionalString(request.input.sourceUri),
            evaluationQuery: readOptionalString(request.input.evaluationQuery),
          }),
        };
      }

      return {
        name: request.name,
        ok: false,
        error: `Unsupported tool: ${request.name}`,
      };
    } catch (error) {
      return {
        name: request.name,
        ok: false,
        error: error instanceof Error ? error.message : "Tool execution failed",
      };
    }
  }

  async #listFiles(relativePath: string): Promise<unknown> {
    const target = this.#resolveWorkspacePath(relativePath);
    const entries = await fs.readdir(target, { withFileTypes: true });
    const allEntries = entries
      .map((entry) => ({
        name: entry.name,
        type: entry.isDirectory() ? "directory" : "file",
        ignored:
          (entry.isDirectory() && lowValueDirectoryNames.has(entry.name)) ||
          (entry.isFile() && isSensitiveEnvFile(entry.name)),
        reason: entry.isDirectory()
          ? "dependency/build/internal directory"
          : "sensitive local environment file",
        priority: highValueEntryNames.has(entry.name) ? 0 : entry.isDirectory() ? 1 : 2,
      }))
      .sort((a, b) => a.priority - b.priority || a.type.localeCompare(b.type) || a.name.localeCompare(b.name));
    const visibleEntries = allEntries
      .filter((entry) => !entry.ignored)
      .map(({ name, type }) => ({ name, type }));
    const ignoredEntries = allEntries
      .filter((entry) => entry.ignored)
      .map(({ name, type, reason }) => ({ name, type, reason }));

    return {
      workspaceRoot: this.#workspaceRoot,
      path: toWorkspaceRelativePath(this.#workspaceRoot, target),
      entries: visibleEntries,
      ignoredEntries,
      summary:
        ignoredEntries.length > 0
          ? `Listed ${visibleEntries.length} relevant entries and ignored ${ignoredEntries.length} low-value or sensitive entries.`
          : `Listed ${visibleEntries.length} relevant entries.`,
    };
  }

  async #readTextFile(relativePath: string, maxCharacters: number): Promise<unknown> {
    const target = this.#resolveWorkspacePath(relativePath);
    const stat = await fs.stat(target);
    if (!stat.isFile()) {
      throw new Error("Target is not a file");
    }

    if (isSensitiveEnvFile(path.basename(target))) {
      throw new Error("Refusing to read sensitive local environment files");
    }

    const extension = path.extname(target).toLowerCase();
    if (extension && !textFileExtensions.has(extension)) {
      throw new Error(`Refusing to read unsupported file type: ${extension}`);
    }

    const content = await fs.readFile(target, "utf8");
    const limit = Math.max(1, Math.min(60_000, maxCharacters));

    return {
      path: toWorkspaceRelativePath(this.#workspaceRoot, target),
      truncated: content.length > limit,
      content: content.slice(0, limit),
    };
  }

  async #writeTextFile(
    relativePath: string,
    content: string,
    overwrite: boolean,
  ): Promise<unknown> {
    const target = this.#resolveWorkspacePath(relativePath);
    const extension = path.extname(target).toLowerCase();
    if (extension && !textFileExtensions.has(extension)) {
      throw new Error(`Refusing to write unsupported file type: ${extension}`);
    }

    if (!overwrite) {
      try {
        const existing = await fs.readFile(target, "utf8");
        if (existing === content) {
          return {
            path: toWorkspaceRelativePath(this.#workspaceRoot, target),
            bytesWritten: 0,
            unchanged: true,
          };
        }

        throw new Error("Target already exists. Set overwrite=true and request approval again.");
      } catch (error) {
        if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") {
          throw error;
        }
      }
    }

    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, "utf8");

    return {
      path: toWorkspaceRelativePath(this.#workspaceRoot, target),
      bytesWritten: Buffer.byteLength(content, "utf8"),
    };
  }

  async #runProjectCheck(target: string): Promise<unknown> {
    const args = createProjectCheckArgs(target);
    const command = createProcessCommand("npm", args);
    const result = await runProcess(command.program, command.args, this.#workspaceRoot, 120_000);

    return {
      target,
      command: ["npm", ...args].join(" "),
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      stdout: trimOutput(result.stdout),
      stderr: trimOutput(result.stderr),
      summary:
        result.exitCode === 0 && !result.timedOut
          ? `Project check passed for ${target}.`
          : `Project check failed for ${target} with exit code ${result.exitCode}.`,
    };
  }

  async #gitStatus(): Promise<unknown> {
    const result = await runProcess("git", ["status", "--short"], this.#workspaceRoot, 30_000);

    return {
      command: "git status --short",
      exitCode: result.exitCode,
      stdout: trimOutput(result.stdout),
      stderr: trimOutput(result.stderr),
      changedFiles: parseGitStatus(result.stdout),
      summary:
        result.exitCode === 0
          ? `Git status found ${parseGitStatus(result.stdout).length} changed entries.`
          : `Git status failed with exit code ${result.exitCode}.`,
    };
  }

  async #gitDiff(maxCharacters: number): Promise<unknown> {
    const result = await runProcess("git", ["diff", "--"], this.#workspaceRoot, 30_000);
    const limit = Math.max(1, Math.min(60_000, maxCharacters));
    const diff = result.stdout.slice(0, limit);

    return {
      command: "git diff --",
      exitCode: result.exitCode,
      truncated: result.stdout.length > limit,
      diff,
      stderr: trimOutput(result.stderr),
      summary:
        result.exitCode === 0
          ? `Git diff returned ${diff.length} characters${result.stdout.length > limit ? " and was truncated" : ""}.`
          : `Git diff failed with exit code ${result.exitCode}.`,
    };
  }

  async #detectDevelopmentTools(): Promise<unknown> {
    const [commands, projectFiles, packageScripts, vsCodeLaunch] = await Promise.all([
      detectCommands(["git", "node", "npm", "cargo", "python", "docker", "UnrealEditor"]),
      this.#findDevelopmentProjectFiles(),
      readPackageScripts(path.join(this.#workspaceRoot, "package.json")),
      resolveVsCodeLaunchProgram(),
    ]);
    commands.unshift({
      name: "vscode",
      available: Boolean(vsCodeLaunch),
      path: vsCodeLaunch?.label,
    });

    const availableTasks = [...developmentTaskNames].map((task) => ({
      task,
      description: createDevelopmentTaskDefinition(task).description,
    }));

    return {
      workspaceRoot: this.#workspaceRoot,
      commands,
      projectFiles,
      packageScripts,
      availableOpenApps: [...developmentOpenApps],
      availableTasks,
      summary: `Detected ${projectFiles.length} development project files and ${commands.filter((command) => command.available).length} available development tools.`,
    };
  }

  async #openDevelopmentTarget(app: string, relativePath: string, line: number): Promise<unknown> {
    const target = this.#resolveWorkspacePath(relativePath);
    const stat = await fs.stat(target);

    if (app === "unreal" && path.extname(target).toLowerCase() !== ".uproject") {
      throw new Error("Unreal targets must be workspace-relative .uproject files");
    }

    const lineNumber = Math.max(0, Math.floor(line));
    const launch =
      app === "vscode"
        ? await createVsCodeLaunch(target, stat.isFile(), lineNumber)
        : createDefaultOpenLaunch(target);
    const pid = await launchDetachedProcess(launch.program, launch.args, this.#workspaceRoot);

    return {
      app,
      path: toWorkspaceRelativePath(this.#workspaceRoot, target),
      command: [launch.label, ...launch.args].join(" "),
      pid,
      summary:
        app === "vscode"
          ? `Opened workspace target in VS Code: ${toWorkspaceRelativePath(this.#workspaceRoot, target)}.`
          : `Opened workspace target with ${app}: ${toWorkspaceRelativePath(this.#workspaceRoot, target)}.`,
    };
  }

  async #runDevelopmentTask(task: string): Promise<unknown> {
    const definition = createDevelopmentTaskDefinition(task);
    const command = createProcessCommand(definition.program, definition.args);
    const result = await runProcess(
      command.program,
      command.args,
      this.#workspaceRoot,
      definition.timeoutMs,
    );

    return {
      task,
      description: definition.description,
      command: [definition.program, ...definition.args].join(" "),
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      stdout: trimOutput(result.stdout),
      stderr: trimOutput(result.stderr),
      summary:
        result.exitCode === 0 && !result.timedOut
          ? `Development task passed: ${definition.description}.`
          : `Development task failed: ${definition.description} exited with ${result.exitCode}.`,
    };
  }

  async #ingestSelectedContent(input: {
    datasetName: string;
    title: string;
    text: string;
    sourceType: DataDocument["sourceType"];
    sourceUri?: string;
    evaluationQuery?: string;
  }): Promise<unknown> {
    if (!this.#dataStore || !this.#embeddingProvider) {
      throw new Error("Selected content ingestion is not configured for this tool registry");
    }

    const ingestResult = await this.#dataStore.ingestText({
      datasetName: input.datasetName,
      title: input.title,
      sourceType: input.sourceType,
      sourceUri: input.sourceUri,
      text: input.text,
      metadata: {
        ingestionMode: "selected-content-tool",
        selectedAt: new Date().toISOString(),
        source: "workspace.ingest_selected_content",
      },
    });
    let embeddedChunks = 0;
    let embeddingModel = "";

    for (const chunk of ingestResult.chunks) {
      const embedding = await this.#embeddingProvider.embed(chunk.content);
      embeddingModel = embedding.model;
      await this.#dataStore.saveChunkEmbedding(chunk.id, embedding.embedding, embedding.model);
      embeddedChunks += 1;
    }

    const evaluationQuery = input.evaluationQuery?.trim() || input.title;
    const queryEmbedding = await this.#embeddingProvider.embed(evaluationQuery);
    const results = await this.#dataStore.searchChunks({
      embedding: queryEmbedding.embedding,
      embeddingModel: queryEmbedding.model,
      datasetId: ingestResult.dataset.id,
      limit: 5,
    });
    const quality = await this.#dataStore.getQualitySummary();
    const datasetQuality = quality.datasets.find(
      (dataset) => dataset.id === ingestResult.dataset.id,
    );

    return {
      dataset: ingestResult.dataset,
      document: ingestResult.document,
      chunks: ingestResult.chunks,
      embeddedChunks,
      embeddingProvider: this.#embeddingProvider.provider,
      embeddingModel: embeddingModel || queryEmbedding.model,
      evaluationQuery,
      results,
      datasetQuality,
      quality,
      summary: `Stored ${ingestResult.chunks.length} selected chunks and embedded ${embeddedChunks} for ${input.datasetName}.`,
    };
  }

  async #findDevelopmentProjectFiles(): Promise<{ path: string; type: string }[]> {
    const matches: { path: string; type: string }[] = [];
    const walk = async (folder: string, depth: number): Promise<void> => {
      if (depth > 4 || matches.length >= 80) {
        return;
      }

      const entries = await fs.readdir(folder, { withFileTypes: true });
      for (const entry of entries) {
        if (matches.length >= 80) {
          return;
        }

        const target = path.join(folder, entry.name);
        if (entry.isDirectory()) {
          if (!lowValueDirectoryNames.has(entry.name)) {
            await walk(target, depth + 1);
          }
          continue;
        }

        const type = classifyDevelopmentProjectFile(entry.name);
        if (type) {
          matches.push({
            path: toWorkspaceRelativePath(this.#workspaceRoot, target),
            type,
          });
        }
      }
    };

    await walk(this.#workspaceRoot, 0);
    return matches.sort((a, b) => a.path.localeCompare(b.path));
  }

  async #ensurePermission(
    request: ReturnType<typeof normalizeToolExecuteRequest>,
  ): Promise<ToolExecutionResult | undefined> {
    const definition = this.list().find((tool) => tool.name === request.name);
    if (!definition?.requiresApproval) {
      return undefined;
    }

    if (
      request.approvalId &&
      (await this.#permissionStore.consumeApproved({
        approvalId: request.approvalId,
        toolName: request.name,
        toolInput: request.input,
      }))
    ) {
      return undefined;
    }

    return {
      name: request.name,
      ok: false,
      error: "permission_required",
      permissionRequest: await this.#permissionStore.create({
        toolName: request.name,
        toolInput: request.input,
        reason: `${request.name} requires approval before execution.`,
      }),
    };
  }

  #resolveWorkspacePath(inputPath: string): string {
    const relativePath = this.#normalizeWorkspacePath(inputPath);

    if (path.isAbsolute(relativePath)) {
      throw new Error("Tool paths must be workspace-relative or inside the configured workspace");
    }

    const target = path.resolve(this.#workspaceRoot, relativePath);
    const relative = path.relative(this.#workspaceRoot, target);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error("Tool path escapes the configured workspace");
    }

    return target;
  }

  #normalizeWorkspacePath(inputPath: string): string {
    const trimmed = inputPath.trim();
    if (["", ".", "/", "\\", "root", "workspace root", "current directory"].includes(trimmed.toLowerCase())) {
      return ".";
    }

    if (!path.isAbsolute(inputPath)) {
      return inputPath;
    }

    const relative = path.relative(this.#workspaceRoot, path.resolve(inputPath));
    if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
      return relative;
    }

    return inputPath;
  }
}

function readString(value: unknown, fallback?: string): string {
  if (typeof value === "string" && value.trim()) {
    return value;
  }

  if (fallback !== undefined) {
    return fallback;
  }

  throw new Error("Expected a non-empty string input");
}

function validateToolInput(request: ReturnType<typeof normalizeToolExecuteRequest>): void {
  if (request.name === "workspace.write_text_file") {
    readString(request.input.path);
    readString(request.input.content);
    return;
  }

  if (request.name === "workspace.read_text_file") {
    readString(request.input.path);
    return;
  }

  if (request.name === "workspace.run_project_check") {
    readProjectCheckTarget(request.input.target);
    return;
  }

  if (request.name === "workspace.open_development_target") {
    readDevelopmentOpenApp(request.input.app);
    readString(request.input.path);
    return;
  }

  if (request.name === "workspace.run_dev_task") {
    readDevelopmentTaskName(request.input.task);
    return;
  }

  if (request.name === "workspace.ingest_selected_content") {
    readString(request.input.datasetName);
    readString(request.input.title);
    readString(request.input.text);
    readDataSourceType(request.input.sourceType, "manual");
  }
}

function readNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readDataSourceType(
  value: unknown,
  fallback: DataDocument["sourceType"],
): DataDocument["sourceType"] {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  const sourceType = readString(value);
  if (!["manual", "file", "url", "api"].includes(sourceType)) {
    throw new Error("Source type must be manual, file, url, or api");
  }

  return sourceType as DataDocument["sourceType"];
}

function readProjectCheckTarget(value: unknown): string {
  const target = readString(value);
  if (!projectCheckTargets.has(target)) {
    throw new Error("Project check target must be api, desktop, or all");
  }

  return target;
}

function readDevelopmentOpenApp(value: unknown): string {
  const app = readString(value);
  if (!developmentOpenApps.has(app)) {
    throw new Error("Development app must be vscode, default, or unreal");
  }

  return app;
}

function readDevelopmentTaskName(value: unknown): string {
  const task = readString(value);
  if (!developmentTaskNames.has(task)) {
    throw new Error("Development task is not allowlisted");
  }

  return task;
}

function createProjectCheckArgs(target: string): string[] {
  if (target === "api") {
    return ["run", "check", "--workspace", "@chenkoai/api"];
  }

  if (target === "desktop") {
    return ["run", "check", "--workspace", "@chenkoai/desktop"];
  }

  return ["run", "check", "--workspaces", "--if-present"];
}

function createDevelopmentTaskDefinition(task: string): DevelopmentTaskDefinition {
  const definitions: Record<string, DevelopmentTaskDefinition> = {
    api_check: {
      task,
      description: "Type-check the local TypeScript API.",
      program: "npm",
      args: ["run", "check", "--workspace", "@chenkoai/api"],
      timeoutMs: 120_000,
    },
    desktop_check: {
      task,
      description: "Type-check the Tauri desktop UI.",
      program: "npm",
      args: ["run", "check", "--workspace", "@chenkoai/desktop"],
      timeoutMs: 120_000,
    },
    agent_core_check: {
      task,
      description: "Type-check the shared agent core package.",
      program: "npm",
      args: ["run", "check", "--workspace", "@chenkoai/agent-core"],
      timeoutMs: 120_000,
    },
    all_checks: {
      task,
      description: "Run all available workspace checks.",
      program: "npm",
      args: ["run", "check", "--workspaces", "--if-present"],
      timeoutMs: 180_000,
    },
    api_build: {
      task,
      description: "Build the local TypeScript API.",
      program: "npm",
      args: ["run", "build", "--workspace", "@chenkoai/api"],
      timeoutMs: 120_000,
    },
    desktop_build: {
      task,
      description: "Build the desktop web UI bundle.",
      program: "npm",
      args: ["run", "build", "--workspace", "@chenkoai/desktop"],
      timeoutMs: 180_000,
    },
    desktop_installer_build: {
      task,
      description: "Build the Windows desktop installer.",
      program: "npm",
      args: ["run", "tauri:build", "--workspace", "@chenkoai/desktop"],
      timeoutMs: 600_000,
    },
    rust_native_check: {
      task,
      description: "Run cargo check for Rust native workspace code.",
      program: "cargo",
      args: ["check"],
      timeoutMs: 180_000,
    },
  };

  const definition = definitions[task];
  if (!definition) {
    throw new Error("Development task is not allowlisted");
  }

  return definition;
}

function createProcessCommand(program: string, args: string[]): { program: string; args: string[] } {
  if (process.platform === "win32") {
    return {
      program: process.env.ComSpec ?? "cmd.exe",
      args: ["/d", "/s", "/c", program, ...args],
    };
  }

  return {
    program,
    args,
  };
}

async function createVsCodeLaunch(
  target: string,
  isFile: boolean,
  line: number,
): Promise<{ program: string; args: string[]; label: string }> {
  const launchProgram = await resolveVsCodeLaunchProgram();
  if (!launchProgram) {
    throw new Error("VS Code is not available through PATH or common install locations");
  }

  const openTarget = isFile && line > 0 ? `${target}:${line}` : target;
  if (launchProgram.kind === "path") {
    return {
      program: launchProgram.value,
      args: ["-g", openTarget],
      label: launchProgram.label,
    };
  }

  return {
    program: process.platform === "win32" ? (process.env.ComSpec ?? "cmd.exe") : launchProgram.value,
    args:
      process.platform === "win32"
        ? ["/d", "/s", "/c", launchProgram.value, "-g", openTarget]
        : ["-g", openTarget],
    label: launchProgram.label,
  };
}

function createDefaultOpenLaunch(target: string): { program: string; args: string[]; label: string } {
  if (process.platform === "win32") {
    return {
      program: process.env.ComSpec ?? "cmd.exe",
      args: ["/d", "/s", "/c", "start", "", target],
      label: "start",
    };
  }

  if (process.platform === "darwin") {
    return { program: "open", args: [target], label: "open" };
  }

  return { program: "xdg-open", args: [target], label: "xdg-open" };
}

async function launchDetachedProcess(
  command: string,
  args: string[],
  cwd: string,
): Promise<number | undefined> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      detached: true,
      shell: false,
      stdio: "ignore",
      windowsHide: true,
    });

    child.on("error", reject);
    child.on("spawn", () => {
      child.unref();
      resolve(child.pid);
    });
  });
}

async function detectCommands(
  names: string[],
): Promise<{ name: string; available: boolean; path?: string }[]> {
  return await Promise.all(
    names.map(async (name) => {
      const available = await commandAvailable(name);
      return { name, available };
    }),
  );
}

async function commandAvailable(name: string): Promise<boolean> {
  const command =
    process.platform === "win32"
      ? { program: process.env.ComSpec ?? "cmd.exe", args: ["/d", "/s", "/c", "where", name] }
      : { program: "sh", args: ["-c", `command -v ${name}`] };
  try {
    const result = await runProcess(command.program, command.args, defaultWorkspaceRoot, 10_000);
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

async function readPackageScripts(packageJsonPath: string): Promise<Record<string, string>> {
  try {
    const content = await fs.readFile(packageJsonPath, "utf8");
    const parsed = JSON.parse(content) as { scripts?: unknown };
    if (!parsed.scripts || typeof parsed.scripts !== "object") {
      return {};
    }

    return Object.fromEntries(
      Object.entries(parsed.scripts).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
  } catch {
    return {};
  }
}

async function resolveVsCodeLaunchProgram(): Promise<
  { kind: "command" | "path"; value: string; label: string } | undefined
> {
  if (await commandAvailable("code")) {
    return { kind: "command", value: "code", label: "code" };
  }

  const candidates =
    process.platform === "win32"
      ? [
          process.env.LOCALAPPDATA
            ? path.join(process.env.LOCALAPPDATA, "Programs", "Microsoft VS Code", "Code.exe")
            : "",
          process.env.ProgramFiles
            ? path.join(process.env.ProgramFiles, "Microsoft VS Code", "Code.exe")
            : "",
          process.env["ProgramFiles(x86)"]
            ? path.join(process.env["ProgramFiles(x86)"], "Microsoft VS Code", "Code.exe")
            : "",
        ]
      : [];

  for (const candidate of candidates.filter(Boolean)) {
    try {
      await fs.access(candidate);
      return { kind: "path", value: candidate, label: candidate };
    } catch {
      // Try the next common install path.
    }
  }

  return undefined;
}

function classifyDevelopmentProjectFile(fileName: string): string | undefined {
  const lower = fileName.toLowerCase();
  if (lower === "package.json") return "node-package";
  if (lower === "cargo.toml") return "rust-package";
  if (lower === "pyproject.toml") return "python-package";
  if (lower.endsWith(".uproject")) return "unreal-project";
  if (lower.endsWith(".sln")) return "visual-studio-solution";
  if (lower.endsWith(".csproj")) return "dotnet-project";
  return undefined;
}

async function runProcess(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<{ exitCode: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      shell: false,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      resolve({ exitCode, stdout, stderr, timedOut });
    });
  });
}

function trimOutput(value: string): string {
  const limit = 8_000;
  return value.length > limit ? `${value.slice(0, limit)}\n... output truncated ...` : value;
}

function parseGitStatus(stdout: string): { status: string; path: string }[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => ({
      status: line.slice(0, 2).trim(),
      path: line.slice(3),
    }));
}

function toWorkspaceRelativePath(workspaceRoot: string, target: string): string {
  const relative = path.relative(workspaceRoot, target);
  return relative || ".";
}

function isSensitiveEnvFile(fileName: string): boolean {
  const normalized = fileName.toLowerCase();
  return normalized.startsWith(".env") && !normalized.includes("example");
}
