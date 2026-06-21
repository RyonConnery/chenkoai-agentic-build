create table if not exists agent_runs (
  id uuid primary key,
  status text not null check (
    status in ('queued', 'planning', 'running', 'waiting', 'completed', 'failed', 'canceled')
  ),
  goal text not null,
  context text,
  max_steps integer not null check (max_steps > 0 and max_steps <= 50),
  plan text[] not null,
  created_at timestamptz not null,
  updated_at timestamptz not null
);

create table if not exists agent_run_steps (
  id uuid primary key,
  run_id uuid not null references agent_runs(id) on delete cascade,
  step_index integer not null check (step_index >= 0),
  title text not null,
  status text not null check (
    status in ('pending', 'running', 'completed', 'failed', 'skipped')
  ),
  details text,
  started_at timestamptz,
  completed_at timestamptz,
  unique (run_id, step_index)
);

create table if not exists agent_run_events (
  id uuid primary key,
  run_id uuid not null references agent_runs(id) on delete cascade,
  type text not null check (
    type in ('created', 'status_changed', 'step_started', 'step_completed')
  ),
  message text not null,
  created_at timestamptz not null
);

create index if not exists agent_runs_status_created_at_idx
  on agent_runs (status, created_at desc);

create index if not exists agent_run_steps_run_id_idx
  on agent_run_steps (run_id, step_index);

create index if not exists agent_run_events_run_id_idx
  on agent_run_events (run_id, created_at);
