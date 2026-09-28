@echo off
title DSH 4004
cd /d "C:\Users\metin\Desktop\DSH v2"
set "DSH_HOME=C:\Users\metin\.dsh-diag"
node --import tsx/esm apps/cli/src/bin.ts web --no-open --port 4004
pause
