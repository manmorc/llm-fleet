@echo off
REM РЕЖИМ САМОРАЗВИТИЯ: агент правит СВОЙ собственный харнес (этот репозиторий).
REM Использование:  dev.cmd
REM Каждая правка кода требует твоего y/N. После правки агент ОБЯЗАН прогнать self_test (регрессию).
REM Всё в git — любую правку можно откатить: git -C %~dp0 checkout -- <файл>
REM Давай ему КОНКРЕТНЫЕ задачи ("добавь тул X", "поправь Y в loop.js") — на абстрактных он слаб.
setlocal
set "AGENT_ROOT=%~dp0"
set "AGENT_ALLOW_RISKY=1"
set "AGENT_SUPERVISOR=ask"
set "AGENT_SELFDEV=1"
echo == РЕЖИМ САМОРАЗВИТИЯ == агент правит свой код в %AGENT_ROOT%
echo Откат правки:  git -C "%~dp0" checkout -- ^<файл^>
node "%~dp0agent\chat.js" %1
endlocal
