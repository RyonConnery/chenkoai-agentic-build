import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  normalizeToolExecuteRequest,
  type LocalToolDefinition,
  type ToolExecuteRequest,
  type ToolExecutionResult,
} from "@chenkoai/agent-core";
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

export class LocalToolRegistry {
  readonly #workspaceRoot: string;
  readonly #permissionStore: ToolPermissionStore;

  constructor(
    permissionStore: ToolPermissionStore,
    workspaceRoot = process.env.CHENKOAI_WORKSPACE_ROOT ?? defaultWorkspaceRoot,
  ) {
    this.#workspaceRoot = path.resolve(workspaceRoot);
    this.#permissionStore = permissionStore;
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
    const command = createProcessCommand(args);
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
  }
}

function readNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function readProjectCheckTarget(value: unknown): string {
  const target = readString(value);
  if (!projectCheckTargets.has(target)) {
    throw new Error("Project check target must be api, desktop, or all");
  }

  return target;
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

function createProcessCommand(args: string[]): { program: string; args: string[] } {
  if (process.platform === "win32") {
    return {
      program: process.env.ComSpec ?? "cmd.exe",
      args: ["/d", "/s", "/c", "npm", ...args],
    };
  }

  return {
    program: "npm",
    args,
  };
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

function toWorkspaceRelativePath(workspaceRoot: string, target: string): string {
  const relative = path.relative(workspaceRoot, target);
  return relative || ".";
}

function isSensitiveEnvFile(fileName: string): boolean {
  const normalized = fileName.toLowerCase();
  return normalized.startsWith(".env") && !normalized.includes("example");
}
