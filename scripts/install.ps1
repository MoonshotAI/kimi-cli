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

$installedTools = & $uvBin tool list 2>&1 | Out-String

if ($installedTools -match "kimi-cli") {
  Write-Host "kimi-cli is already installed." -ForegroundColor Yellow
  $response = Read-Host "Do you want to check for updates and upgrade? (Y/n)"

  if ($response -eq "" -or $response -match "^[Yy]") {
    Write-Host "Upgrading kimi-cli..." -ForegroundColor Cyan
    & $uvBin tool upgrade kimi-cli
  } else {
    Write-Host "Upgrade skipped." -ForegroundColor Green
  }
} else {
  Write-Host "kimi-cli not found. Installing..." -ForegroundColor Cyan
  & $uvBin tool install --python 3.13 kimi-cli
}
