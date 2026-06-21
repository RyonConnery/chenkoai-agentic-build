# Desktop Control Center

The desktop app now provides an operator console for ChenkoAI agent runs. It opens as a Tauri Windows shell, starts the local API for this repo checkout, creates runs, plans work, starts bounded autonomous loops, and handles tool approval requests.

## Start Locally

Run the native desktop shell:

```powershell
npm run tauri:dev --workspace @chenkoai/desktop
```

This starts the React desktop UI and the local ChenkoAI API automatically.

To build the Windows installer:

```powershell
npm run tauri:build --workspace @chenkoai/desktop
```

Build outputs:

- `target\release\chenkoai-agentic-build-desktop.exe`
- `target\release\bundle\nsis\ChenkoAI Agentic Build_0.1.0_x64-setup.exe`

The desktop UI expects the API at `http://127.0.0.1:8787`.

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
- The current packaged app starts the API from this repo checkout. A future sidecar build should bundle the API so the installer can run independently on machines without Node.js or the source tree.
- Real desktop packaging should move the API base URL into desktop configuration instead of keeping it hardcoded.
- Durable operation should use PostgreSQL-backed stores instead of memory stores.
