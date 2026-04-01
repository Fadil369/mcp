@echo off
REM Launcher script for oracle-scanner with increased memory limit to prevent OOM crashes.
REM Usage: run-scanner.cmd [args...]
REM Example: run-scanner.cmd --payload nphies_normalized_submissions.json --limit 5 --resume
node --max-old-space-size=4096 --expose-gc "%~dp0oracle-scanner.mjs" %*
