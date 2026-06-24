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

ChenkoAI still cannot run shell commands, install packages, or access paths outside the configured workspace through this local tool layer.
