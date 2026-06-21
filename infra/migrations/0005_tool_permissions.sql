create table if not exists tool_permission_requests (
  id uuid primary key,
  tool_name text not null,
  tool_input jsonb not null,
  input_key text not null,
  status text not null check (status in ('pending', 'approved', 'denied', 'used')),
  reason text not null,
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  decided_by text
);

create index if not exists tool_permission_requests_status_created_at_idx
  on tool_permission_requests (status, created_at desc);

create index if not exists tool_permission_requests_tool_input_idx
  on tool_permission_requests (tool_name, input_key);
