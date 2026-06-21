# Desktop Control Center

The desktop app now provides an operator console for ChenkoAI agent runs. It connects to the local API, creates runs, plans work, starts bounded autonomous loops, and handles tool approval requests.

## Start Locally

Start the API first:

```powershell
$env:DATA_STORE='memory'
$env:EMBEDDING_PROVIDER='mock'
$env:MODEL_PROVIDER='mock'
$env:AGENT_RUN_STORE='memory'
$env:PROMPT_REGISTRY_STORE='memory'
$env:TOOL_PERMISSION_STORE='memory'
$env:CHENKOAI_WORKSPACE_ROOT='C:\Users\rtc12\Documents\Codex\2026-06-21\when\chenkoai-agentic-build\local-workspace'
npx tsx apps/api/src/server.ts
```

Then run the desktop app:

```powershell
npm run dev --workspace @chenkoai/desktop
```

The desktop expects the API at `http://127.0.0.1:8787`.

## Operator Workflow

1. Create a run with a goal, context, and max step limit.
2. Use `Plan` to generate an explicit step plan.
3. Use `Auto Run` to let the bounded agent loop advance through steps.
4. Review the run report for status, progress, tool executions, pending permissions, and next action.
5. Approve or deny any pending tool permission from the report panel.

When a permission is approved in the desktop app, the app records the decision and immediately executes the approved tool against the selected run.

## Permission Smoke Test

Use this context to make the mock model request a guarded file write:

```text
MOCK_TOOL_WRITE:desktop-note.md:Desktop approved write
```

Expected result:

- `Auto Run` pauses with a pending permission.
- `Approve` records the decision and executes the write tool.
- The report shows no pending approvals after refresh.
- The permission queue shows the permission history.

## Production Notes

- The API sends CORS headers for the desktop origin. Use `CHENKOAI_DESKTOP_ORIGIN` to restrict it in packaged builds.
- Real desktop packaging should move the API base URL into desktop configuration instead of keeping it hardcoded.
- Durable operation should use PostgreSQL-backed stores instead of memory stores.
