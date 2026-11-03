; 用生产安装器的路径校验函数跑无界面回归，不安装应用或写注册表。
Unicode true
!include "MUI2.nsh"
!define PRODUCT_NAME "HyperPlayer"
!define APP_GUID "HyperPlayer-Path-Validation"
!define WF_PREVIEW
!define BUILD_RESOURCES_DIR "${SRC}/build"
!define isUpdated `0 == 1`

Name "HyperPlayer path validation"
OutFile "${OUT}/path-validation.exe"
RequestExecutionLevel user
SilentInstall silent

Var installMode
Var isForceMachineInstall
Var isForceCurrentInstall
Var newDesktopLink
Var launchLink

!addincludedir "${SRC}/node_modules/app-builder-lib/templates/nsis/include"
!addincludedir "${SRC}"
!include "build\installer.nsh"

Function .onInit
  FileOpen $1 "$EXEDIR\path-input.txt" r
  FileReadUTF16LE $1 $0
  FileClose $1
  Call WaveValidatePathSyntax
  FileOpen $1 "$EXEDIR\path-output.txt" w
  FileWriteUTF16LE $1 "$WavePathError$\r$\n$WaveValidatedPath"
  FileClose $1
  SetErrorLevel 0
  Quit
FunctionEnd

Function WaveFinishRun
  Quit
FunctionEnd

Section
SectionEnd
