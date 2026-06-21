#!/usr/bin/env pwsh
# Установка воркера llm-fleet ОДНОЙ командой на Windows (PowerShell as admin):
#   $env:REDIS_URL='redis://<ip>:6379'; irm http://<ts-ip>:8088/ps1 | iex
# Аналог install.sh: Ollama + Node-check + clone/pull + npm + .env + авто-подбор MODEL + ollama pull + pm2-сервис.
# MODEL подбирается по железу (см. лестницу $ModelLadder). Если $env:MODEL задан — авто-подбор пропускается.
# Идемпотентно: повторный запуск = обновление/починка.
$ErrorActionPreference = 'Stop'

# ── Лестница моделей: подбор по бюджету памяти (GB). РЕДАКТИРУЙ ТУТ, чтобы сменить семейство. ──
# Зеркало MODEL_LADDER из install.sh. Бюджет Q4 ≈ params×0.65 GB. Сортировка по убыванию.
# Тир (Routing v2) определяет очередь воркера llm:<тир>: strong|fast (embed зарезервирован).
$ModelLadder = @(
  @{ Min = 22; Model = 'qwen3:32b'; Tier = 'strong' }
  @{ Min = 11; Model = 'qwen3:14b'; Tier = 'fast'   }
  @{ Min = 6;  Model = 'qwen3:8b';  Tier = 'fast'   }
  @{ Min = 0;  Model = 'qwen3:4b';  Tier = 'fast'   }   # light (всё, что меньше 6GB) тоже в fast
)
$EmbedModel = 'nomic-embed-text'       # эмбеддинги тянет КАЖДЫЙ узел

$Repo        = if ($env:LLM_FLEET_REPO) { $env:LLM_FLEET_REPO } else { 'https://github.com/manmorc/llm-fleet.git' }
$Dir         = if ($env:LLM_FLEET_DIR)  { $env:LLM_FLEET_DIR }  else { Join-Path $HOME 'llm-fleet' }
$RedisUrl    = if ($env:REDIS_URL)      { $env:REDIS_URL }      else { 'redis://127.0.0.1:6379' }
$OllamaUrl   = if ($env:OLLAMA_URL)     { $env:OLLAMA_URL }     else { 'http://127.0.0.1:11434' }
$Concurrency = if ($env:CONCURRENCY)    { $env:CONCURRENCY }    else { '2' }

# ── Определение бюджета памяти (GB) + выбор модели ──────────────────────────────
# budget = NVIDIA dGPU → VRAM · иначе → RAM×0.6 (на Windows нет Apple unified; CPU-only капается light/embed).
function Get-Budget {
  $kind = 'cpu'; $budget = 0; $cpuOnly = $true

  # NVIDIA dGPU? VRAM в MiB → GB.
  $smi = Get-Command nvidia-smi -ErrorAction SilentlyContinue
  if ($smi) {
    $vramMib = (& nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits 2>$null | Select-Object -First 1)
    $vramMib = ("$vramMib").Trim()
    if ($vramMib -match '^\d+$' -and [int]$vramMib -gt 0) {
      $kind = 'nvidia'; $cpuOnly = $false
      $budget = [int]([int]$vramMib / 1024)
    }
  }

  # Нет dGPU → RAM × 0.6 (CPU-only).
  if ($kind -eq 'cpu') {
    $ramBytes = (Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory
    $ramGb = [int]($ramBytes / 1GB)
    $budget = [int]($ramGb * 0.6)
  }

  return [pscustomobject]@{ Kind = $kind; Budget = $budget; CpuOnly = $cpuOnly }
}

# Возвращает рунг { Model; Tier }, подобранный по бюджету (CPU-only → самый лёгкий).
function Select-Model {
  param([int]$Budget, [bool]$CpuOnly)
  $chosen = $null
  foreach ($rung in $ModelLadder) {
    if ($Budget -ge $rung.Min) { $chosen = $rung; break }
  }
  if (-not $chosen) { $chosen = $ModelLadder[-1] }

  # CPU-only: не запускаем тяжёлую генерацию — потолок light (самый лёгкий рунг).
  if ($CpuOnly) { $chosen = $ModelLadder[-1] }
  return $chosen
}

# Тир модели из лестницы (Routing v2). Если модели нет в лестнице — fast.
function Tier-ForModel {
  param([string]$M)
  foreach ($rung in $ModelLadder) { if ($rung.Model -eq $M) { return $rung.Tier } }
  return 'fast'
}

if ($env:MODEL) {
  $Model = $env:MODEL
  # TIER из env имеет приоритет, иначе выводим из лестницы (по умолчанию fast).
  $Tier  = if ($env:TIER) { $env:TIER } else { Tier-ForModel -M $Model }
  Write-Host "> MODEL задан явно: $Model (тир=$Tier, авто-подбор пропущен)"
} else {
  $hw = Get-Budget
  $rung = Select-Model -Budget $hw.Budget -CpuOnly $hw.CpuOnly
  $Model = $rung.Model
  # Явный TIER из env имеет приоритет над выведенным из лестницы.
  $Tier  = if ($env:TIER) { $env:TIER } else { $rung.Tier }
  $cap = if ($hw.CpuOnly) { ' (CPU-only -> потолок light)' } else { '' }
  Write-Host "> железо: $($hw.Kind) · бюджет ~$($hw.Budget)GB$cap -> MODEL=$Model тир=$Tier"
}

Write-Host "> llm-fleet -> $Dir  (redis=$RedisUrl  model=$Model  tier=$Tier  embed=$EmbedModel)"

# ── Зависимости ─────────────────────────────────────────────────────────────────
# Node 18+ обязателен (как в install.sh — не ставим автоматически).
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Error "Нужен Node.js 18+ (поставь: winget install OpenJS.NodeJS.LTS — и повтори)"; exit 1
}
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  Write-Error "Нужен git (поставь: winget install Git.Git — и повтори)"; exit 1
}

# Ollama: winget, иначе официальный установщик.
if (-not (Get-Command ollama -ErrorAction SilentlyContinue)) {
  Write-Host "> ставлю Ollama"
  if (Get-Command winget -ErrorAction SilentlyContinue) {
    winget install --id Ollama.Ollama -e --accept-source-agreements --accept-package-agreements
  } else {
    $tmp = Join-Path $env:TEMP 'OllamaSetup.exe'
    Invoke-WebRequest -Uri 'https://ollama.com/download/OllamaSetup.exe' -OutFile $tmp
    Start-Process -FilePath $tmp -ArgumentList '/SILENT' -Wait
  }
  # обновить PATH в текущей сессии, чтобы ollama стал виден без перезапуска шелла
  $env:Path = [System.Environment]::GetEnvironmentVariable('Path','Machine') + ';' +
              [System.Environment]::GetEnvironmentVariable('Path','User')
}

# pm2 как сервис-менеджер (как в bash-флоу).
if (-not (Get-Command pm2 -ErrorAction SilentlyContinue)) {
  Write-Host "> ставлю pm2"; npm install -g pm2
}

# ── Репо ──────────────────────────────────────────────────────────────────────
if (Test-Path (Join-Path $Dir '.git')) {
  Write-Host "> обновляю репо"; git -C $Dir pull --ff-only
} else {
  Write-Host "> клонирую"; git clone $Repo $Dir
}
Set-Location $Dir
Write-Host "> npm install"; npm install --omit=dev

# ── .env (тот же набор, что и в install.sh) ─────────────────────────────────────
@"
REDIS_URL=$RedisUrl
MODEL=$Model
TIER=$Tier
OLLAMA_URL=$OllamaUrl
CONCURRENCY=$Concurrency
"@ | Set-Content -Path (Join-Path $Dir '.env') -Encoding utf8 -NoNewline

# ── Модели ──────────────────────────────────────────────────────────────────────
Write-Host "> тяну модель $Model"
try { ollama pull $Model } catch { Write-Warning "не удалось ollama pull $Model — подтяни вручную позже" }
Write-Host "> тяну эмбеддинги $EmbedModel"
try { ollama pull $EmbedModel } catch { Write-Warning "не удалось ollama pull $EmbedModel — подтяни вручную позже" }

# ── Сервис через pm2 (autorestart + автозапуск после ребута) ─────────────────────
# pm2 на Windows: pm2-startup ставит задачу автозапуска; pm2 save сохраняет процесс-лист.
pm2 start ecosystem.config.js
pm2 save
if (-not (Get-Command pm2-startup -ErrorAction SilentlyContinue)) {
  npm install -g pm2-windows-startup 2>$null
}
try { pm2-startup install | Out-Null } catch { Write-Warning "pm2-startup install не прошёл — настрой автозапуск вручную" }
pm2 save

Write-Host "OK Воркер запущен. Проверка:  node $Dir\bin\fleet.js status   |   pm2 logs llm-fleet"
