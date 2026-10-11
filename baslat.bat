@echo off
title DSH 4004
cd /d "C:\Users\metin\Desktop\DSH v2"
set "DSH_HOME=C:\Users\metin\.dsh-diag"
rem --trusted-host: tunnel (dsh.ottonline1553.xyz -> http://4004) icin /api ve
rem event-stream fence'inin bu otoriteyi kabul etmesi; localhost tek basina yeterli degil.
rem ---------------------------------------------------------------------------
rem KONSOL SAHIPLIGI SOZLESMESI
rem
rem Sorun: bu dosya eskiden "node ..." + "pause" ile bitiyordu. Pencereyi
rem kapattiginda backend'i calistiran cmd.exe olur ve backend KONSOLSUZ kalir.
rem Konsolsuz bir surecten dogan, konsola ihtiyac duyan torunlar (pwsh, cmd)
rem KENDILERINE YENI konsol tahsis eder; Windows Terminal bunlari masaustunde
rem gorunur pencere olarak acar.
rem
rem Cozum: bu dosya konsolu SAHIPLENIR ve backend cikinca onu yeniden baslatir.
rem Konsol sahibi yasadigi surece torunlar ayni konsolu miras alir ve
rem masaustunde hicbir yeni terminal penceresi acilmaz.
rem ---------------------------------------------------------------------------

:loop
echo [%date% %time%] DSH 4004 baslatiliyor... >> "%~dp0dsh-4004.log"
node --import tsx/esm apps/cli/src/bin.ts web --no-open --port 4004 --trusted-host dsh.ottonline1553.xyz >> "%~dp0dsh-4004.log" 2>&1
echo [%date% %time%] backend cikti (kod %ERRORLEVEL%), 2 sn sonra yeniden baslatiliyor... >> "%~dp0dsh-4004.log"
timeout /t 2 /nobreak >nul
goto loop
