@echo off
rem Двойной клик: поднять приложение и открыть его в браузере.
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$busy=$false; try { $c=New-Object Net.Sockets.TcpClient; $c.Connect('127.0.0.1',4100); $busy=$true; $c.Close() } catch {}; if (-not $busy) { Start-Process -WindowStyle Hidden -FilePath node -ArgumentList 'app/server.cjs' -WorkingDirectory (Get-Location).Path; Start-Sleep -Seconds 4 }"
start "" http://127.0.0.1:4100
