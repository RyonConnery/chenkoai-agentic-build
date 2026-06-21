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

## Temporary Persistence

The API currently uses an in-memory `AgentRunStore`. This is intentional for the first lifecycle slice. The API routes already depend on a storage boundary, so the next persistence milestone can replace that store with PostgreSQL without redesigning the route shape.

