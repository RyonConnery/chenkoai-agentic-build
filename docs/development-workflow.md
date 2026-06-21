# Development Workflow

This project should evolve in small, verified steps.

## Default Loop

1. Define the next product capability.
2. Update contracts and data models first.
3. Implement the narrowest working slice.
4. Run checks.
5. Commit and push.
6. Update the backup copy when the milestone matters.

## Verification

Use the full local check before commits:

```powershell
npm run check:all
```

This checks:

- TypeScript API, desktop, and shared packages.
- Rust native workspace.
- Rust formatting.
- Python AI worker syntax.

## Agentic Build Priorities

The early product should focus on these foundations:

- Agent run lifecycle.
- Model provider abstraction.
- Prompt registry.
- Tool permission model.
- Persistent memory.
- Local desktop control surface.
- Audit logs for autonomous actions.

## Branching

Use `main` for stable work. Use short feature branches once the project has multiple active streams.

Example:

```powershell
git switch -c add-agent-run-storage
```

