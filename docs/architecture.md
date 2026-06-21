# Architecture

ChenkoAI Agentic Build is designed as a local-first agentic software platform.

## Layers

1. Desktop Shell
   - Tauri-hosted downloadable application.
   - React/TypeScript UI.
   - Talks to local or hosted ChenkoAI APIs.

2. API Gateway
   - TypeScript service.
   - Owns user-facing API routes, agent run creation, authentication boundaries, and orchestration.

3. Agent Core
   - Shared TypeScript package.
   - Defines agent inputs, plans, tool contracts, prompt templates, and run state.

4. AI Worker
   - Python service.
   - Owns embeddings, retrieval, model evaluation, dataset processing, and future model training workflows.

5. Native Core
   - Rust crate.
   - Owns secure local system capabilities and future performance-sensitive operations.

6. Data Layer
   - PostgreSQL for accounts, projects, runs, audit logs, and durable memory.
   - pgvector or Qdrant for vector memory and retrieval.

## Provider Strategy

The system should treat all model providers as replaceable adapters:

- OpenAI-compatible hosted APIs.
- Other hosted LLM providers.
- Local LLM runtimes.
- Future ChenkoAI-hosted or ChenkoAI-trained models.

No prompt, agent, or product workflow should be hardcoded to a single provider.

