@echo off
REM ================================================================
REM  run-all-sites.cmd  — Scan all 6 OASIS Plus branches
REM  Log: artifacts\oracle-portal\<site>\scan_<site>.log
REM ================================================================
setlocal

cd /d "%~dp0"

REM -- Locate node.exe (portable install or system PATH) ----------
if exist "nodejs\node.exe" (
    set NODE_EXE=nodejs\node.exe
) else if exist "C:\nodejs\node.exe" (
    set NODE_EXE=C:\nodejs\node.exe
) else (
    set NODE_EXE=node
)

echo [%date% %time%] Starting multi-site Oracle scan...
echo Node: %NODE_EXE%

"%NODE_EXE%" --max-old-space-size=4096 --expose-gc scripts/run-all-sites.mjs --resume --fast %*

echo [%date% %time%] Multi-site scan complete. Exit: %ERRORLEVEL%
pause
