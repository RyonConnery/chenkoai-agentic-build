# Agent Run Lifecycle

An agent run is the core unit of autonomous work in ChenkoAI.

## Current API

```text
POST /agent/runs
GET  /agent/runs
GET  /agent/runs/:id
POST /agent/runs/:id/plan
POST /agent/runs/:id/advance
POST /agent/runs/:id/auto
POST /agent/runs/:id/tools/execute
```

`POST /agent/run` is kept as a compatibility alias for early local testing.

`POST /agent/runs/:id/plan` asks the configured model provider to create goal-specific step titles, then replaces the queued default plan. Plans can only be replaced before a run starts.

`POST /agent/runs/:id/advance` starts the next pending step and asks the configured model provider to produce output for that step. The generated output is saved on the step as `details`.

Before generation, the runtime searches embedded ChenkoAI data chunks using the run goal, run context, current step title, and completed step details. The top matches are injected into the step prompt as relevant memory.

`POST /agent/runs/:id/auto` runs a bounded supervised loop. It can plan first, advance multiple steps, and stop when the run completes, reaches `maxCycles`, stops making progress, or hits a permission request.

```json
{
  "planFirst": true,
  "maxCycles": 8
}
```

## Agent Tools

`POST /agent/runs/:id/tools/execute` executes a local tool against the run's active step. The tool result is appended to the step details so the run keeps a transcript of actions and outputs.

Permissioned tools return a permission request first. Approve the request through `/tools/permissions/:id/decision`, then retry the same agent tool call with `approvalId`.

The model can also propose a tool action during `advance` by returning a fenced `chenkoai-tool` JSON block. The runtime parses that block, routes it through the same permission gate, and appends the tool result or permission request to the active step transcript.

## Statuses

- `queued`: run was accepted and is waiting to start.
- `planning`: reserved for future planner expansion.
- `running`: at least one step is active.
- `waiting`: reserved for human approval, tool permission, or external input.
- `completed`: all planned steps finished.
- `failed`: the run stopped because of an error.
- `canceled`: the user or system canceled the run.

## Step Statuses

- `pending`
- `running`
- `completed`
- `failed`
- `skipped`

## Persistence

The API can use either in-memory storage or PostgreSQL.

```powershell
AGENT_RUN_STORE=memory
AGENT_RUN_STORE=postgres
```

Use memory for quick local smoke tests. Use PostgreSQL for durable agent runs, steps, and events.

## Memory Retrieval

Agent memory uses the same data ingestion and embedding pipeline as `/data/search`.

```powershell
DATA_STORE=postgres
EMBEDDING_PROVIDER=mock
AGENT_MEMORY_RESULTS=4
```

Set `AGENT_MEMORY_RESULTS=0` to disable retrieval. Increase it to include more chunks in each step prompt.

## Database Migration

The first persistence migration is:

```text
infra/migrations/0001_agent_run_lifecycle.sql
```

Apply migrations with:

```powershell
npm run db:migrate
```

If PostgreSQL is running through Docker Compose, use:

```powershell
npm run db:migrate:docker
```

## Local PostgreSQL Mode

Start the database services:

```powershell
docker compose -f infra/docker-compose.yml up -d postgres
```

Apply the schema:

```powershell
npm run db:migrate:docker
```

Run the API with durable storage:

```powershell
$env:AGENT_RUN_STORE="postgres"
$env:DATABASE_URL="postgresql://chenkoai:chenkoai_dev_password@localhost:5432/chenkoai"
npm run dev
```

Docker and `psql` must be available on PATH for the commands above.
