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
    ];
  }

  async execute(input: ToolExecuteRequest): Promise<ToolExecutionResult> {
    const request = normalizeToolExecuteRequest(input);

    try {
      const permissionResult = this.#ensurePermission(request);
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

    return {
      workspaceRoot: this.#workspaceRoot,
      path: toWorkspaceRelativePath(this.#workspaceRoot, target),
      entries: entries
        .map((entry) => ({
          name: entry.name,
          type: entry.isDirectory() ? "directory" : "file",
        }))
        .sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name)),
    };
  }

  async #readTextFile(relativePath: string, maxCharacters: number): Promise<unknown> {
    const target = this.#resolveWorkspacePath(relativePath);
    const stat = await fs.stat(target);
    if (!stat.isFile()) {
      throw new Error("Target is not a file");
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
        await fs.stat(target);
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

  #ensurePermission(request: ReturnType<typeof normalizeToolExecuteRequest>): ToolExecutionResult | undefined {
    const definition = this.list().find((tool) => tool.name === request.name);
    if (!definition?.requiresApproval) {
      return undefined;
    }

    if (
      request.approvalId &&
      this.#permissionStore.consumeApproved({
        approvalId: request.approvalId,
        toolName: request.name,
        toolInput: request.input,
      })
    ) {
      return undefined;
    }

    return {
      name: request.name,
      ok: false,
      error: "permission_required",
      permissionRequest: this.#permissionStore.create({
        toolName: request.name,
        toolInput: request.input,
        reason: `${request.name} requires approval before execution.`,
      }),
    };
  }

  #resolveWorkspacePath(relativePath: string): string {
    if (path.isAbsolute(relativePath)) {
      throw new Error("Tool paths must be workspace-relative");
    }

    const target = path.resolve(this.#workspaceRoot, relativePath);
    const relative = path.relative(this.#workspaceRoot, target);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error("Tool path escapes the configured workspace");
    }

    return target;
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

function readNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function toWorkspaceRelativePath(workspaceRoot: string, target: string): string {
  const relative = path.relative(workspaceRoot, target);
  return relative || ".";
}
