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
```

## Current Tools

```text
workspace.list_files
workspace.read_text_file
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

The first tool layer is read-only. It can list workspace folders and read common text/code files, but it cannot write files, run shell commands, install packages, or access paths outside the configured workspace.

Future write or command tools should require an explicit permission model before execution.
