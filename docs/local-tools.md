# Local Tools

ChenkoAI exposes a guarded local tool registry for autonomous project work.

## Configuration

```text
CHENKOAI_WORKSPACE_ROOT=.
```

Tool paths must be relative to this workspace root. Absolute paths and `..` escapes are rejected.

## API

```text
GET  /tools
POST /tools/execute
GET  /tools/permissions
POST /tools/permissions/:id/decision
```

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

Then execute the same tool input with the approval id:

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
