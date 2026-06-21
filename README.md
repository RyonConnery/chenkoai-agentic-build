# chenkoai-agentic-build

ChenkoAI Agentic Build is the foundation for an independent, downloadable agentic AI software application.

The project is organized as a monorepo so the desktop app, API, agent engine, AI worker, database, prompts, and infrastructure can grow together without being tangled together.

## Core Stack

- TypeScript for the desktop UI, API layer, agent orchestration, and shared packages.
- Rust for native desktop capabilities, secure local system access, and future high-performance runtime components.
- Python for AI workers, embeddings, data pipelines, evaluation, and future model training.
- PostgreSQL plus pgvector for durable data and vector memory.
- Docker Compose for local infrastructure.

## Repository Layout

```text
apps/
  api/        TypeScript HTTP API and agent gateway
  desktop/    Tauri + React desktop application shell
packages/
  agent-core/ Shared TypeScript agent contracts, prompts, and workflow logic
services/
  ai-worker/  Python AI service for embeddings, RAG, evaluation, and model tasks
crates/
  native-core/ Rust native library for secure local operations
infra/
  docker-compose.yml
  migrations/
docs/
  agent-run-lifecycle.md
  architecture.md
  environment.md
  development-workflow.md
  roadmap.md
```

## First Local Setup

1. Install Node.js, Python, Docker Desktop, and Rust.
2. Copy `.env.example` to `.env`.
3. Fill in local keys and database values.
4. Run installs once dependencies are available:

```powershell
npm install
npm run check:all
```

Rust is installed and the native workspace has been verified with Cargo.

## Development Commands

```powershell
npm run dev
npm run check
npm run check:all
npm run format
cargo check
cargo fmt --check
```

## Security Note

Never commit real API keys, database passwords, signing certificates, model provider keys, or production `.env` files.
