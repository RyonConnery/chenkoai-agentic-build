# Data Ingestion

ChenkoAI stores source data as datasets, documents, and chunks. This is the base layer for future embeddings, retrieval, and training/evaluation datasets.

## Storage

```text
DATA_STORE=memory
DATA_STORE=postgres
```

Use `memory` for quick development. Use `postgres` for durable data.

## API

```text
POST /data/ingest/text
POST /data/ingestion/studio
POST /data/embeddings/rebuild
POST /data/search
GET  /data/datasets
GET  /data/documents
GET  /data/documents?datasetId=...
GET  /data/documents/:id
GET  /data/documents/:id/chunks
```

## Text Ingestion

Example:

```json
{
  "datasetName": "chenkoai-core",
  "title": "Agentic Build Notes",
  "sourceType": "manual",
  "text": "ChenkoAI should store durable memory...",
  "metadata": {
    "topic": "memory"
  }
}
```

The ingestion service:

- Creates or reuses a dataset by name.
- Stores the document with source metadata and a content hash.
- Splits text into ordered chunks.
- Stores token estimates for later embedding and cost planning.

## Content Ingestion Studio

Use Content Ingestion Studio when you want ChenkoAI to remember specific chosen content instead of scanning the full workspace:

```json
{
  "datasetName": "chenkoai-knowledge-base",
  "title": "Production Data Foundation Notes",
  "sourceKind": "pasted_text",
  "sourceUri": "planning-session",
  "text": "Important content ChenkoAI should remember...",
  "evaluationQuery": "What production data foundation guidance was added?"
}
```

`POST /data/ingestion/studio` stores the selected source, chunks it, embeds the stored chunks immediately, runs a retrieval check using `evaluationQuery`, and returns dataset quality counts plus top matching chunks. The desktop control center exposes this as `Content Ingestion Studio`.

Supported source kinds:

- `pasted_text`: stores the supplied text as a manual memory document.
- `workspace_file`: reads and stores one workspace-relative text/code file from `path`.
- `workspace_folder`: reads and stores text/code files from one workspace-relative folder, capped by `maxFiles`.

The response includes document count, chunk count, embedded chunk count, duplicate count, skipped sources, retrieval score, and ready-for-agent-memory status.

## Embeddings

Apply embeddings to chunks:

```json
{
  "limit": 100
}
```

The rebuild endpoint embeds chunks that do not have vectors yet. Include `datasetId` to rebuild one dataset.

## Search

Search embedded chunks by meaning:

```json
{
  "query": "durable ChenkoAI memory",
  "limit": 5
}
```

The search response returns matching chunks, document details, dataset details, and vector distance. Lower distance means a closer match.

The desktop control center includes a Memory Search & Repair panel for production checks:

- Search stored chunks across all datasets or one selected dataset.
- Inspect chunk sources and match scores before asking the model to answer.
- Rebuild missing embeddings for all datasets or the selected dataset.
- Confirm dataset quality counts after scans, restores, and embedding repairs.

## Next Step

Feed top search results into agent runs so planning and generation can use ChenkoAI memory.
