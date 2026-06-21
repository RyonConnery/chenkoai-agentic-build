# Agent Run Lifecycle

An agent run is the core unit of autonomous work in ChenkoAI.

## Current API

```text
POST /agent/runs
GET  /agent/runs
GET  /agent/runs/:id
POST /agent/runs/:id/advance
```

`POST /agent/run` is kept as a compatibility alias for early local testing.

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
