@echo off
rem Double-click to open the Laptop Guardian dashboard (starts the local bridge if needed).
powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0src\powershell\Start-Dashboard.ps1" -Gui
