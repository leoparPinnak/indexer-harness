@echo off
title DSH 1234
cd /d "%~dp0"
set "DSH_HOME=%USERPROFILE%\.indexer-harness"
rem --trusted-host: tunnel (dsh.ottonline1553.xyz -> http://1234) icin /api ve
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
cls
echo ========================================================
echo   DSH Web Sunucusu: http://127.0.0.1:1234/
echo   Log Takibi      : %~dp0dsh-1234.log
echo ========================================================
echo [%date% %time%] DSH 1234 baslatiliyor... >> "%~dp0dsh-1234.log"
node --import tsx/esm apps/cli/src/bin.ts web --no-open --port 1234 --trusted-host dsh.ottonline1553.xyz >> "%~dp0dsh-1234.log" 2>&1
echo [%date% %time%] backend cikti (kod %ERRORLEVEL%), 2 sn sonra yeniden baslatiliyor... >> "%~dp0dsh-1234.log"
echo Sunucu durdu (kod %ERRORLEVEL%). 2 sn icinde yeniden baslatilacak...
timeout /t 2 /nobreak >nul
goto loop
