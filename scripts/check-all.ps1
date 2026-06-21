$ErrorActionPreference = "Stop"

function Resolve-CommandPath {
  param(
    [Parameter(Mandatory = $true)]
    [string] $Name,
    [string[]] $Fallbacks = @()
  )

  $command = Get-Command $Name -ErrorAction SilentlyContinue
  if ($command) {
    return $command.Source
  }

  foreach ($fallback in $Fallbacks) {
    if (Test-Path $fallback) {
      return $fallback
    }
  }

  throw "Could not find required command: $Name"
}

$cargo = Resolve-CommandPath "cargo" @("$env:USERPROFILE\.cargo\bin\cargo.exe")

npm run check
& $cargo check
& $cargo fmt --check
python -m py_compile services/ai-worker/src/chenkoai_ai_worker/main.py

