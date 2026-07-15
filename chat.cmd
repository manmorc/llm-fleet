@echo off
REM Чат с локальным агентом desktop-local (gemma-8B) + харнес.
REM Использование:  chat.cmd [рабочая_папка]
REM По умолчанию рабочая папка = текущая. Действия (запись/shell) ВКЛючены под аппрувом y/N.
REM Заведомо-опасное (rm -rf, секреты, autorun) блокируется безусловно.
setlocal
set "AGENT_ROOT=%~1"
if "%AGENT_ROOT%"=="" set "AGENT_ROOT=%CD%"
set "AGENT_ALLOW_RISKY=1"
set "AGENT_SUPERVISOR=ask"
node "%~dp0agent\chat.js" %2
endlocal
