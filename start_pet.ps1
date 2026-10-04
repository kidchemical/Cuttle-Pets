#Requires -Version 5.1
<#
.SYNOPSIS
  Launch Cuttle Pets on Windows: control server, Cuttle bridge, Tauri window.
.DESCRIPTION
  Mirrors start_pet.sh. Reuses an already-running control server, starts the
  Cuttle bridge unless $env:CUTTLE_PET_BRIDGE is '0', then runs the Tauri
  dev window in app/. Ctrl+C stops everything this script started.
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\start_pet.ps1
#>
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $Root
New-Item -ItemType Directory -Force -Path "$Root\temp" | Out-Null

function Find-Python {
    $cand = @()
    if ($env:CUTTLE_PET_PYTHON) { $cand += $env:CUTTLE_PET_PYTHON }
    $cand += "$Root\.venv\Scripts\python.exe", 'python', 'python3'
    foreach ($c in $cand) {
        try {
            & $c -c 'import flask, numpy, soundcard' 2>$null
            if ($LASTEXITCODE -eq 0) { return $c }
        } catch { }
    }
    return $null
}

$Python = Find-Python
if (-not $Python) {
    Write-Error 'Python 3 with Flask, NumPy, and SoundCard is required. Run: python -m venv .venv; .\.venv\Scripts\pip.exe install -r requirements.txt'
}

foreach ($cmd in @('npm', 'cargo')) {
    if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) {
        Write-Error "$cmd is required. npm ships with Node.js; cargo ships with Rust."
    }
}

$jobs = @()
try {
    & $Python cli/cuttle_pet.py status >$null 2>&1
    if ($LASTEXITCODE -ne 0) {
        $srv = Start-Job -Name 'pet-server' -ScriptBlock {
            param($Root, $Python)
            Set-Location $Root
            & $Python server/server.py > "$Root\temp\pet-server.log" 2>&1
        } -ArgumentList $Root, $Python
        $jobs += $srv
        $ready = $false
        for ($i = 0; $i -lt 100; $i++) {
            & $Python cli/cuttle_pet.py status >$null 2>&1
            if ($LASTEXITCODE -eq 0) { $ready = $true; break }
            if ($srv.State -ne 'Running') { break }
            Start-Sleep -Milliseconds 200
        }
        if (-not $ready) {
            Get-Content "$Root\temp\pet-server.log" -ErrorAction SilentlyContinue |
                Write-Error
            throw 'Control server did not become ready.'
        }
    }
    if ($env:CUTTLE_PET_BRIDGE -ne '0') {
        $jobs += Start-Job -Name 'pet-bridge' -ScriptBlock {
            param($Root, $Python)
            Set-Location $Root
            & $Python bridge/bridge.py --verbose
        } -ArgumentList $Root, $Python
    }
    Set-Location "$Root\app"
    npm run tauri dev
} finally {
    Set-Location $Root
    foreach ($j in $jobs) {
        Stop-Job $j -ErrorAction SilentlyContinue
        Remove-Job $j -Force -ErrorAction SilentlyContinue
    }
}
