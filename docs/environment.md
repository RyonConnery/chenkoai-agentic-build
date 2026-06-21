# Environment Setup

Use `.env.example` as the source of truth for local development variables.

## Local Files

- `.env` is for shared local service settings.
- `.env.local` is for machine-specific overrides.
- Production secrets should live in a real secrets manager, not in Git.

## Required Secret Categories

- LLM provider API keys.
- Database credentials.
- Signing certificates for downloadable builds.
- OAuth credentials if user accounts are added.
- Object storage credentials if datasets or artifacts are stored remotely.

## Provider Independence

ChenkoAI should use model provider adapters so the application can move between hosted APIs, local models, and future ChenkoAI-owned models without rewriting product workflows.

## Model Provider

`MODEL_PROVIDER=mock` is the default for local development.

Use `MODEL_PROVIDER=openai-compatible` with `OPENAI_API_KEY`, `OPENAI_BASE_URL`, and `OPENAI_MODEL`.

Use `MODEL_PROVIDER=local-http` with `LOCAL_LLM_BASE_URL` and `LOCAL_LLM_MODEL`.

## Embedding Provider

`EMBEDDING_PROVIDER=mock` is the default for local development and does not require network access.

Use `EMBEDDING_PROVIDER=openai-compatible` with `OPENAI_API_KEY`, `OPENAI_BASE_URL`, and `OPENAI_EMBEDDING_MODEL`.

Use `EMBEDDING_PROVIDER=local-http` with `LOCAL_LLM_BASE_URL` and `LOCAL_EMBEDDING_MODEL`.

## Prompt Registry

`PROMPT_REGISTRY_STORE=memory` uses built-in prompt templates.

`PROMPT_REGISTRY_STORE=postgres` stores prompt templates in PostgreSQL and seeds defaults at API startup.

## Data Store

`DATA_STORE=memory` keeps ingested data in-process for quick tests.

`DATA_STORE=postgres` stores datasets, documents, and chunks in PostgreSQL.

## Agent Run Storage

`AGENT_RUN_STORE=memory` keeps runs in-process for quick local development.

`AGENT_RUN_STORE=postgres` stores runs, steps, and events in PostgreSQL using `DATABASE_URL`.

## Tool Permission Storage

`TOOL_PERMISSION_STORE=memory` keeps permission requests in-process for quick local development.

`TOOL_PERMISSION_STORE=postgres` stores permission requests, approvals, denials, and used approvals in PostgreSQL.

Local default:

```text
DATABASE_URL=postgresql://chenkoai:chenkoai_dev_password@localhost:5432/chenkoai
```

When using Docker Compose, the default Postgres container name is:

```text
POSTGRES_CONTAINER_NAME=infra-postgres-1
```
