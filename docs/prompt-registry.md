# Prompt Registry

ChenkoAI keeps prompt templates in a registry so prompts can be versioned, tested, and replaced without burying product behavior inside runtime code.

## Current API

```text
GET /prompts
GET /prompts/:id
```

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
