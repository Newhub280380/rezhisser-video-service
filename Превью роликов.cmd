@echo off
rem Double-click launcher for the preview page: every rendered reel, watch and
rem approve before it goes to a client.
cd /d "%~dp0"

if not exist "out" mkdir "out"
node scripts\preview.mjs "out" --open
