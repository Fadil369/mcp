#Requires -RunAsAdministrator
<#
.SYNOPSIS
    Installs the OASIS Unified Portal as a Windows service (NSSM-free, uses SC + wrapper).
.DESCRIPTION
    Registers a scheduled task that launches portal/server.mjs on boot and keeps it running.
    Exposes the portal on http://127.0.0.1:3458 → cloudflared → portals.elfadil.com
#>

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$TaskName   = "OasisUnifiedPortal"
$NodeExe    = if (Test-Path "C:\nodejs\node.exe") { "C:\nodejs\node.exe" } else { (Get-Command node -ErrorAction SilentlyContinue).Source }
$ScriptPath = "C:\oracle-scanner\portal\server.mjs"
$LogFile    = "C:\oracle-scanner\portal\portal.log"
$WrapperPath = "C:\oracle-scanner\portal\start-portal.cmd"

if (-not $NodeExe) { throw "node.exe not found. Run setup first." }
if (-not (Test-Path $ScriptPath)) { throw "Portal server not found: $ScriptPath" }

Write-Host "=== Installing Unified Portal Service ===" -ForegroundColor Cyan

# Create CMD wrapper (redirects logs, restarts on exit)
Set-Content -Path $WrapperPath -Encoding ASCII -Value @"
@echo off
:loop
"$NodeExe" "$ScriptPath" >> "$LogFile" 2>&1
timeout /t 5 /nobreak >nul
goto loop
"@
Write-Host "[1/3] Wrapper script: $WrapperPath" -ForegroundColor Green

# Remove existing task
if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "       Removed old task." -ForegroundColor Yellow
}

$action    = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c `"$WrapperPath`""
$trigger   = New-ScheduledTaskTrigger -AtStartup
$settings  = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) `
                -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 2) `
                -MultipleInstances IgnoreNew -StartWhenAvailable
$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
    -Settings $settings -Principal $principal `
    -Description "Unified OASIS Plus Portal — portals.elfadil.com" | Out-Null

Write-Host "[2/3] Scheduled task registered." -ForegroundColor Green

# Start it now
Start-ScheduledTask -TaskName $TaskName
Write-Host "[3/3] Portal started." -ForegroundColor Green

Write-Host ""
Write-Host "  Local  : http://127.0.0.1:3458" -ForegroundColor White
Write-Host "  Public : https://portals.elfadil.com (via cloudflared)" -ForegroundColor White
Write-Host "  Logs   : $LogFile" -ForegroundColor White
Write-Host ""
Write-Host "  Add to cloudflared config.yml:" -ForegroundColor Cyan
Write-Host "    hostname: portals.elfadil.com" -ForegroundColor White
Write-Host "    service:  http://localhost:3458" -ForegroundColor White
