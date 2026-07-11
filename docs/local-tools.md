# Local Tools

ChenkoAI exposes a guarded local tool registry for autonomous project work.

## Configuration

```text
CHENKOAI_WORKSPACE_ROOT=.
TOOL_PERMISSION_STORE=memory
TOOL_PERMISSION_STORE=postgres
```

Tool paths must be relative to this workspace root. Absolute paths and `..` escapes are rejected.
Use `postgres` when pending approvals and decisions should survive API restarts.

## API

```text
GET  /tools
POST /tools/execute
GET  /tools/permissions
POST /tools/permissions/:id/decision
POST /agent/runs/:id/tools/execute
POST /agent/runs/:id/permissions/:permissionId/execute
```

Use `/tools/execute` for standalone tool testing. Use `/agent/runs/:id/tools/execute` when a tool result should be recorded on the active agent run step.

Agent step generation can also propose a tool action by returning a fenced `chenkoai-tool` JSON block. Proposed actions are executed through the same permission flow as manual agent tool calls.

## Current Tools

```text
workspace.list_files
workspace.read_text_file
workspace.write_text_file
workspace.run_project_check
workspace.git_status
workspace.git_diff
workspace.detect_development_tools
workspace.open_development_target
workspace.run_dev_task
workspace.content_ingestion_studio
```

Example:

```json
{
  "name": "workspace.read_text_file",
  "input": {
    "path": "README.md",
    "maxCharacters": 4000
  }
}
```

## Safety

Read tools can list workspace folders and read common text/code files without approval. Write tools require approval before execution.

The first write tool is `workspace.write_text_file`. It can write common text/code files inside the workspace only.
If the target file already exists with the exact approved content, the write is treated as a successful no-op so repeated approved steps do not fail unnecessarily.

`workspace.run_project_check` requires approval and can only run allowlisted commands:

```text
npm run check --workspace @chenkoai/api
npm run check --workspace @chenkoai/desktop
npm run check --workspaces --if-present
```

It does not accept arbitrary shell commands.

`workspace.git_status` and `workspace.git_diff` are read-only tools for change awareness. They expose the current workspace status and tracked-file diff so the agent can verify what changed before reporting or requesting checks.

`workspace.detect_development_tools` is read-only. It detects installed command-line tools such as `code`, `git`, `node`, `npm`, `cargo`, `python`, `docker`, and `UnrealEditor`, plus workspace project files such as `package.json`, `Cargo.toml`, `.sln`, `.csproj`, and `.uproject`.

`workspace.open_development_target` requires approval. It can open only workspace-relative files or folders in an approved application:

```text
vscode
default
unreal
```

Unreal opens are restricted to `.uproject` files inside the configured workspace. This tool launches the target and returns immediately; it does not grant arbitrary shell access.

`workspace.run_dev_task` requires approval and can only run allowlisted development tasks:

```text
api_check
desktop_check
agent_core_check
all_checks
api_build
desktop_build
desktop_installer_build
rust_native_check
```

Each task maps to a fixed command and timeout. The tool returns exit code, stdout, stderr, timeout state, and a summary.

`workspace.content_ingestion_studio` requires approval. It stores chosen content as ChenkoAI memory, chunks it, embeds the stored chunks immediately, runs a retrieval check, and returns dataset quality, retrieval score, source list, skipped sources, and ready-for-agent-memory status.

Example:

```json
{
  "name": "workspace.content_ingestion_studio",
  "input": {
    "datasetName": "chenkoai-knowledge-base",
    "title": "Production Data Foundation Notes",
    "sourceKind": "pasted_text",
    "text": "Important content ChenkoAI should remember...",
    "evaluationQuery": "What production data foundation guidance was added?"
  }
}
```

Supported `sourceKind` values:

- `pasted_text`: ingest text supplied in the tool input.
- `workspace_file`: ingest one workspace-relative text/code file from `path`.
- `workspace_folder`: ingest text/code files from one workspace-relative folder, capped by `maxFiles`.

## Permission Flow

Request a gated tool:

```json
{
  "name": "workspace.write_text_file",
  "input": {
    "path": "notes/example.md",
    "content": "Approved local write."
  }
}
```

The response includes `permissionRequest.id` and `ok: false`.

Approve it:

```json
{
  "approved": true,
  "decidedBy": "local-user"
}
```

Then execute the approved permission against the run:

```text
POST /agent/runs/:id/permissions/:permissionId/execute
```

That run-scoped endpoint verifies that the permission belongs to the selected run and consumes the one-use approval. Lower-level callers can still execute the same tool input with the approval id:

```json
{
  "name": "workspace.write_text_file",
  "approvalId": "...",
  "input": {
    "path": "notes/example.md",
    "content": "Approved local write."
  }
}
```

Approvals are one-use and tied to the exact tool input.

ChenkoAI still cannot run arbitrary shell commands, install packages, or access paths outside the configured workspace through this local tool layer.
