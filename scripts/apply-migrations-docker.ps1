$ErrorActionPreference = "Stop"

function Resolve-Docker {
  $docker = Get-Command docker -ErrorAction SilentlyContinue
  if ($docker) {
    return $docker.Source
  }

  $fallback = "C:\Program Files\Docker\Docker\resources\bin\docker.exe"
  if (Test-Path $fallback) {
    return $fallback
  }

  throw "docker was not found on PATH or at $fallback."
}

$docker = Resolve-Docker
$container = $env:POSTGRES_CONTAINER_NAME
if (-not $container) {
  $container = "infra-postgres-1"
}

$migrationRoot = Join-Path $PSScriptRoot "..\infra\migrations"
$migrations = Get-ChildItem -Path $migrationRoot -Filter "*.sql" | Sort-Object Name

foreach ($migration in $migrations) {
  $target = "/tmp/$($migration.Name)"
  Write-Host "Copying migration $($migration.Name) to $container"
  & $docker cp $migration.FullName "${container}:$target"

  Write-Host "Applying migration $($migration.Name)"
  & $docker exec $container psql -U chenkoai -d chenkoai -v ON_ERROR_STOP=1 -f $target
}

Write-Host "Docker migrations complete."
