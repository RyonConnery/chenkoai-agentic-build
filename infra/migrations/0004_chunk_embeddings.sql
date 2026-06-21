create extension if not exists vector;

alter table data_chunks
  add column if not exists embedding vector,
  add column if not exists embedding_model text,
  add column if not exists embedded_at timestamptz;

create index if not exists data_chunks_embedding_ready_idx
  on data_chunks (dataset_id, embedded_at)
  where embedding is not null;
