@echo off
set PATH=C:\nodejs;%PATH%
start /B "" C:\nodejs\node.exe C:\oracle-scanner\portal\server.mjs > C:\oracle-scanner\portal-server.log 2>&1
