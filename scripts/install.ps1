$ErrorActionPreference = "Stop"

function Install-Uv {
  Invoke-RestMethod -Uri "https://astral.sh/uv/install.ps1" | Invoke-Expression

  # Update the PATH environment variable for the current session
  $MachinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  if (-not $MachinePath) { $MachinePath = '' }
  $UserPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  if (-not $UserPath) { $UserPath = '' }
  $env:PATH = "$($MachinePath.TrimEnd(';'));$($UserPath.TrimEnd(';'))".Split(';', [System.StringSplitOptions]::RemoveEmptyEntries) -join ';'
}

if (Get-Command uv -ErrorAction SilentlyContinue) {
  $uvBin = "uv"
} else {
  Install-Uv
  $uvBin = "uv"
}

if (-not (Get-Command $uvBin -ErrorAction SilentlyContinue)) {
  Write-Error "Error: uv not found after installation."
  exit 1
}

& $uvBin tool install --python 3.13 kimi-cli
