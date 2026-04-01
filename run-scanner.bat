@echo off
echo Starting Oracle Scanner at %date% %time%
cd /d C:\Users\rcmrejection3\oracle-scanner
node --max-old-space-size=4096 --expose-gc oracle-scanner.mjs --payload nphies_normalized_submissions.json --fast --limit 5 --headless true
echo Completed at %date% %time%
pause
