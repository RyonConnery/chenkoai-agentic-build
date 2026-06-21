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

## Next Step

Feed top search results into agent runs so planning and generation can use ChenkoAI memory.
