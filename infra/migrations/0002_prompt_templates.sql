create table if not exists prompt_templates (
  id text not null,
  version text not null,
  description text not null,
  system text not null,
  user_template text not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (id, version)
);

create index if not exists prompt_templates_active_idx
  on prompt_templates (id, active, created_at desc);
