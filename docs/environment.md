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

