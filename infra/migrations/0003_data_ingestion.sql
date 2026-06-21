create table if not exists data_datasets (
  id uuid primary key,
  name text not null unique,
  description text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists data_documents (
  id uuid primary key,
  dataset_id uuid not null references data_datasets(id) on delete cascade,
  title text not null,
  source_type text not null check (source_type in ('manual', 'file', 'url', 'api')),
  source_uri text,
  metadata jsonb not null default '{}'::jsonb,
  content_hash text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists data_chunks (
  id uuid primary key,
  document_id uuid not null references data_documents(id) on delete cascade,
  dataset_id uuid not null references data_datasets(id) on delete cascade,
  chunk_index integer not null check (chunk_index >= 0),
  content text not null,
  token_estimate integer not null check (token_estimate > 0),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (document_id, chunk_index)
);

create index if not exists data_documents_dataset_created_at_idx
  on data_documents (dataset_id, created_at desc);

create index if not exists data_documents_content_hash_idx
  on data_documents (content_hash);

create index if not exists data_chunks_document_idx
  on data_chunks (document_id, chunk_index);

create index if not exists data_chunks_dataset_idx
  on data_chunks (dataset_id, created_at desc);
