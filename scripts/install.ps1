$ErrorActionPreference = "Stop"

function Install-Uv {
  Invoke-RestMethod -Uri "https://astral.sh/uv/install.ps1" | Invoke-Expression
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

& $uvBin tool install --python 3.14 gitrekt-cli
