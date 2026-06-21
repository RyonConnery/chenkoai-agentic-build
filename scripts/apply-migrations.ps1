$ErrorActionPreference = "Stop"

if (-not $env:DATABASE_URL) {
  $env:DATABASE_URL = "postgresql://chenkoai:chenkoai_dev_password@localhost:5432/chenkoai"
}

$psql = Get-Command psql -ErrorAction SilentlyContinue
if (-not $psql) {
  throw "psql was not found on PATH. Install PostgreSQL tools or run migrations from a shell that has psql."
}

$migrationRoot = Join-Path $PSScriptRoot "..\infra\migrations"
$migrations = Get-ChildItem -Path $migrationRoot -Filter "*.sql" | Sort-Object Name

foreach ($migration in $migrations) {
  Write-Host "Applying migration $($migration.Name)"
  & $psql.Source $env:DATABASE_URL -v ON_ERROR_STOP=1 -f $migration.FullName
}

Write-Host "Migrations complete."
