@echo off
REM Full scan: all patients, fast mode, with resume support.
REM Output is logged to scan_stdout.log and scan_stderr.log.
REM Note: this runs in the current console session. If you close the window, the scan will stop.
echo Starting full Oracle scan at %date% %time% ...
echo Logs: scan_stdout.log / scan_stderr.log
echo Monitor: type scan_stdout.log  OR  type artifacts\oracle-portal\run-*\actions.log

cd /d "%~dp0"
node --max-old-space-size=4096 --expose-gc oracle-scanner.mjs --payload nphies_normalized_submissions.json --fast --resume --headless true > scan_stdout.log 2> scan_stderr.log

echo Scan finished at %date% %time% with exit code %ERRORLEVEL%
pause
