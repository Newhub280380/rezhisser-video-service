@echo off
rem Double-click launcher: start the service (hidden) if it is not running,
rem then open the studio in the default browser.
cd /d "%~dp0"

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$busy = $false; try { $c = New-Object Net.Sockets.TcpClient; $c.Connect('127.0.0.1',3999); $busy = $true; $c.Close() } catch { }; if (-not $busy) { Start-Process -WindowStyle Hidden -FilePath node -ArgumentList '--env-file-if-exists=.env','src/server.js' -WorkingDirectory (Get-Location).Path; Start-Sleep -Seconds 7 }"

start "" http://127.0.0.1:3999/film
