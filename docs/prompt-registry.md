# Prompt Registry

ChenkoAI keeps prompt templates in a registry so prompts can be versioned, tested, and replaced without burying product behavior inside runtime code.

## Current API

```text
GET /prompts
GET /prompts/:id
```

## Storage

The registry supports in-memory and PostgreSQL-backed storage.

```text
PROMPT_REGISTRY_STORE=memory
PROMPT_REGISTRY_STORE=postgres
```

When PostgreSQL is enabled, default templates are seeded into `prompt_templates` at API startup.

## Current Template

```text
agent.step.output
```

Version:

```text
2026-06-21.1
```

This template produces the system and user prompt used when an agent run advances into a new active step.

## Template Variables

- `goal`
- `context`
- `completedSteps`
- `stepNumber`
- `stepTitle`

## Next Direction

The in-code registry is the first step. Later, templates can move to PostgreSQL with activation controls, evaluation results, and rollout history.
Prompt templates now have a PostgreSQL table. Next, the API can add create/update endpoints with activation controls.
