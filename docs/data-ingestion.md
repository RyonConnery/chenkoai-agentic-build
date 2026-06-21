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

## Next Step

Add embeddings for `data_chunks` using pgvector, then retrieve relevant chunks into agent runs.
