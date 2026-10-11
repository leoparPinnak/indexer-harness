@echo off
setlocal enabledelayedexpansion
rem ===========================================================================
rem native/cua/build.cmd - offline build for the CodexNative computer-use helper
rem (codex-computer-use replica: native COM UIA + SendInput + WGC/WinRT).
rem
rem Requires: Visual Studio Build Tools with the MSVC x64 toolset + a Windows
rem SDK 10 (both confirmed present on this machine). No network access, no
rem package manager, no cargo - cl.exe links only against system import libs.
rem
rem Output: bin\cua-helper.exe, copied to
rem         ..\..\packages\experimental\cua-native\bin\cua-helper.exe
rem ===========================================================================
set "ROOT=%~dp0"

set "VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
if not exist "%VSWHERE%" set "VSWHERE=%ProgramFiles%\Microsoft Visual Studio\Installer\vswhere.exe"
if not exist "%VSWHERE%" (
  echo build.cmd: vswhere.exe not found - install Visual Studio Build Tools 1>&2
  exit /b 1
)

set "VSROOT="
for /f "usebackq tokens=*" %%i in (`"%VSWHERE%" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`) do set "VSROOT=%%i"
if not defined VSROOT (
  echo build.cmd: no Visual Studio installation with the MSVC x64 toolset 1>&2
  exit /b 1
)

call "%VSROOT%\Common7\Tools\VsDevCmd.bat" -arch=amd64 -no_logo
if errorlevel 1 (
  echo build.cmd: VsDevCmd.bat failed 1>&2
  exit /b 1
)

rem C++/WinRT headers ship inside the Windows SDK under Include\<ver>\cppwinrt.
set "CPPWINRT="
if defined WindowsSdkDir if defined WindowsSDKVersion if exist "%WindowsSdkDir%Include\%WindowsSDKVersion%cppwinrt" set "CPPWINRT=%WindowsSdkDir%Include\%WindowsSDKVersion%cppwinrt"
if not defined CPPWINRT (
  for /d %%d in ("%WindowsSdkDir%Include\10.*") do (
    if exist "%%d\cppwinrt" set "CPPWINRT=%%d\cppwinrt"
  )
)
if not defined CPPWINRT (
  echo build.cmd: could not locate the SDK cppwinrt headers 1>&2
  exit /b 1
)

if not exist "%ROOT%bin" mkdir "%ROOT%bin"
if not exist "%ROOT%obj" mkdir "%ROOT%obj"
del /q "%ROOT%obj\*.obj" 2>nul

cl /nologo /std:c++17 /O2 /W4 /EHsc /utf-8 /DUNICODE /D_UNICODE /D_CRT_SECURE_NO_WARNINGS ^
  /external:anglebrackets /external:W0 ^
  /I"%ROOT%src" /I"%CPPWINRT%" ^
  "%ROOT%src\json.cpp" ^
  "%ROOT%src\uia.cpp" ^
  "%ROOT%src\input.cpp" ^
  "%ROOT%src\capture.cpp" ^
  "%ROOT%src\main.cpp" ^
  /Fo"%ROOT%obj\\" ^
  /Fe"%ROOT%bin\cua-helper.exe" ^
  /link /SUBSYSTEM:CONSOLE ^
  ole32.lib oleaut32.lib uiautomationcore.lib windowscodecs.lib ^
  d3d11.lib dxgi.lib gdi32.lib user32.lib shell32.lib shcore.lib advapi32.lib dwmapi.lib ^
  windowsapp.lib
if errorlevel 1 (
  echo build.cmd: cl.exe failed 1>&2
  exit /b 1
)

set "PKG=%ROOT%..\..\packages\experimental\cua-native\bin"
if not exist "%PKG%" mkdir "%PKG%"
copy /y "%ROOT%bin\cua-helper.exe" "%PKG%\cua-helper.exe" >nul
if errorlevel 1 (
  echo build.cmd: failed to copy the prebuilt helper into the TS package 1>&2
  exit /b 1
)

echo build.cmd: built %ROOT%bin\cua-helper.exe
echo build.cmd: prebuilt copy at %PKG%\cua-helper.exe
exit /b 0
