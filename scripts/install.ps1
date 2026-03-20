$ErrorActionPreference = "Stop"

function Install-Uv {
  try {
    Invoke-RestMethod -Uri "https://astral.sh/uv/install.ps1" | Invoke-Expression
  } catch {
    Write-Host ""
    Write-Host "ERROR: Failed to download or execute the uv installer." -ForegroundColor Red
    Write-Host "  $_" -ForegroundColor Red
    Write-Host ""
    Write-Host "This is usually caused by a restrictive PowerShell execution policy." -ForegroundColor Yellow
    Write-Host "To fix this, run the following command first:" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "  Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope Process" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "Then re-run the installation command." -ForegroundColor Yellow
    Write-Host ""
    Write-Host "Press any key to exit..."
    $null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
    exit 1
  }
}

if (Get-Command uv -ErrorAction SilentlyContinue) {
  $uvBin = "uv"
} else {
  Install-Uv
  $uvBin = "uv"
}

if (-not (Get-Command $uvBin -ErrorAction SilentlyContinue)) {
  Write-Host "Error: uv not found after installation." -ForegroundColor Red
  Write-Host "Press any key to exit..."
  $null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
  exit 1
}

& $uvBin tool install --python 3.13 kimi-cli
