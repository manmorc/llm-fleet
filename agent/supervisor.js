const fs = require('fs');
const path = require('path');
const os = require('os');

// Надзор за рисковыми действиями автономного агента desktop-local.
// Пока не доверяем агенту (8B-модель) — каждое рисковое действие (shell/write) проходит ГЕЙТ:
//   1) статические гардрейлы (hard-deny заведомо-деструктивного — безусловно, даже в allow),
//   2) аппрув ревьюера (deny | allow | file | bus).
// Всё логируется в аудит (§7 честность: ничего молча). Результаты верифицируются пост-фактум надзором.

const HOME = os.homedir();
const AUDIT = process.env.AGENT_AUDIT || path.join(HOME, '.agent-bus', 'desktop-local.audit.log');
const PENDING_DIR = path.join(HOME, '.agent-bus', 'pending-approvals');
const MODE = process.env.AGENT_SUPERVISOR || 'deny';           // deny | allow | file | bus
const SUPERVISOR_ID = process.env.AGENT_SUPERVISOR_ID || 'desktop-tt4i69c'; // кто ревьюит в bus-режиме
const TIMEOUT_MS = parseInt(process.env.AGENT_APPROVAL_TIMEOUT || '120000', 10);

// Заведомо-деструктивные паттерны — блок безусловно (детектор самоповреждения/эксфильтрации).
// Списки sensitive/autorun заимствованы из Personal_Assistant (file_safety.py) — усилен детект.
const HARD_DENY = [
  /\brm\s+-[rf]/i, /\bformat\b/i, /\bdel\s+\/[sqf]/i, /rmdir\s+\/s/i, /Remove-Item[^\n]*-Recurse/i,
  /\bshutdown\b/i, /\brestart-computer\b/i, /\breg\s+(add|delete)\b/i, /\bnetsh\b/i, /\bmkfs\b/i,
  /\bdd\s+if=/i, /\|\s*(sh|bash|iex|Invoke-Expression)/i, /Invoke-Expression/i, /\bcurl\b[^\n]*\|/i,
  /\bschtasks\b/i, /New-ScheduledTask/i, /\bnet\s+user\b/i, /\bicacls\b/i, /-EncodedCommand/i,
  // эксфильтрация секретов через shell (чтение чувствительных путей):
  /(cat|type|more|less|Get-Content|\bgc\b|copy|cp|scp|curl|Invoke-WebRequest)\b[^\n]*(\.ssh|\.aws|\.env\b|\.env\.|id_rsa|id_ed25519|credentials|\.pem\b|\.key\b|\.p12\b|\.pfx\b|agent\.key|rag\.env)/i,
  // запись/модификация autorun-файлов (имплицитное исполнение = вектор персистентности/инъекции):
  /(>|>>|Out-File|Set-Content|Add-Content|echo[^\n]*>)[^\n]*(\.bashrc|\.zshrc|\.profile|\.bash_profile|\.zprofile|profile\.ps1|sitecustomize|conftest\.py|\.git[\/\\]hooks|autostart|startup)/i,
];

fs.mkdirSync(path.dirname(AUDIT), { recursive: true });

function audit(entry) {
  try { fs.appendFileSync(AUDIT, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n'); } catch (_) {}
}
function hardBlocked(args) {
  const s = JSON.stringify(args || {});
  for (const re of HARD_DENY) if (re.test(s)) return re.source;
  return null;
}
const rid = () => 'apr_' + Math.abs((JSON.stringify(process.hrtime()) + AUDIT).split('').reduce((a, c) => (a * 31 + c.charCodeAt(0)) | 0, 7)).toString(36);

// file-режим: заявка в pending-approvals/<id>.json; ждём decision-файл <id>.decision (allow|deny).
async function fileReview(req) {
  fs.mkdirSync(PENDING_DIR, { recursive: true });
  const base = path.join(PENDING_DIR, req.id);
  fs.writeFileSync(base + '.json', JSON.stringify(req, null, 2));
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (fs.existsSync(base + '.decision')) {
      const d = fs.readFileSync(base + '.decision', 'utf8').trim().toLowerCase();
      try { fs.unlinkSync(base + '.json'); fs.unlinkSync(base + '.decision'); } catch (_) {}
      return { allowed: d.startsWith('allow'), reason: `file-review: ${d}` };
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  try { fs.unlinkSync(base + '.json'); } catch (_) {}
  return { allowed: false, reason: 'file-review: таймаут ожидания решения' };
}

// ask-режим: интерактивный y/N в терминале (для solo-CLI, борроу из Personal_Assistant).
async function askReview(req) {
  if (!process.stdin.isTTY && process.env.AGENT_ASSUME_TTY !== '1') {
    // нет терминала (pm2/скрипт) → безопасный дефолт: отказ
    return { allowed: false, reason: 'ask-review: нет TTY, авто-отказ' };
  }
  const rl = require('readline').createInterface({ input: process.stdin, output: process.stdout });
  const q = `\n🔐 АППРУВ: "${req.tool}" ${JSON.stringify(req.args)}${req.reason ? ' · цель: ' + req.reason : ''}\n   Разрешить? [y/N] `;
  const ans = await new Promise((resolve) => rl.question(q, resolve));
  rl.close();
  const yes = /^\s*(y|yes|да|д)\s*$/i.test(ans || '');
  return { allowed: yes, reason: `ask-review: ${yes ? 'разрешено' : 'отклонено'} пользователем` };
}

// bus-режим: заявка supervisor'у (desktop-tt4i69c=Claude) через Redis, ждём решение в agents:approvals:<id>.
async function busReview(req) {
  const IORedis = require('ioredis');
  const keys = require('../mcp/keys');
  const URL = process.env.REDIS_URL;
  if (!URL) return { allowed: false, reason: 'bus-review: нет REDIS_URL' };
  const r = new IORedis(URL, { maxRetriesPerRequest: null });
  try {
    const rec = { from: 'desktop-local', to: SUPERVISOR_ID, kind: 'approval-request', reqId: req.id,
      text: `🔐 APPROVAL: тул "${req.tool}" args=${JSON.stringify(req.args)} · причина: ${req.reason || '-'} · ответь: node agent/approve.js ${req.id} allow|deny`, ts: Date.now() };
    rec.sig = keys.sign(rec);
    await r.rpush('agents:inbox:' + SUPERVISOR_ID, JSON.stringify(rec));
    await r.expire('agents:inbox:' + SUPERVISOR_ID, 7 * 24 * 3600);
    const res = await r.blpop('agents:approvals:' + req.id, Math.ceil(TIMEOUT_MS / 1000)); // [key, "allow|deny"]
    if (!res) return { allowed: false, reason: 'bus-review: таймаут (надзор не ответил)' };
    return { allowed: String(res[1]).toLowerCase().startsWith('allow'), reason: `bus-review: ${res[1]}` };
  } finally { try { await r.quit(); } catch (_) {} }
}

// Главный гейт: вызывается перед выполнением рискового тула. Возвращает {allowed, reason, id}.
async function gate({ tool, args, reason }) {
  const id = rid();
  const hb = hardBlocked(args);
  if (hb) { audit({ phase: 'blocked-hard', id, tool, args, rule: hb }); return { allowed: false, reason: `hard-deny: /${hb}/`, id }; }
  let decision;
  if (MODE === 'allow') decision = { allowed: true, reason: 'supervisor=allow' };
  else if (MODE === 'deny') decision = { allowed: false, reason: 'supervisor=deny (надзор не настроен)' };
  else if (MODE === 'ask') decision = await askReview({ id, tool, args, reason });
  else if (MODE === 'file') decision = await fileReview({ id, tool, args, reason });
  else if (MODE === 'bus') decision = await busReview({ id, tool, args, reason });
  else decision = { allowed: false, reason: `неизвестный режим надзора: ${MODE}` };
  audit({ phase: decision.allowed ? 'approved' : 'denied', id, tool, args, mode: MODE, reason: decision.reason });
  return { ...decision, id };
}

// Маркеры провала/аномалии в выводе рискового действия (пост-факт верификация).
const FAIL_MARKERS = [/\berror\b/i, /\bexception\b/i, /traceback/i, /\bdenied\b/i, /\bnot found\b/i, /не найден/i, /отказ/i, /\bfatal\b/i, /command not found/i, /permission/i, /\bENOENT\b/i, /\bEACCES\b/i];

// Пост-фактум верификация: сверяет результат с намерением (эвристика) → verdict в аудит.
// Путь к доверию (supervised-shell): надзор видит не только «что запущено», но и «чем кончилось».
function verifyResult(tool, result) {
  const s = String(result);
  if (s.startsWith('⛔ BLOCKED')) return { verdict: 'blocked', note: 'гейт не пропустил' };
  for (const re of FAIL_MARKERS) if (re.test(s)) return { verdict: 'suspicious', note: `маркер провала: /${re.source}/` };
  return { verdict: 'ok', note: '' };
}

// Пост-фактум: залогировать результат + verdict верификации (для надзора).
function recordResult(id, tool, ok, resultPreview) {
  const v = verifyResult(tool, resultPreview);
  audit({ phase: 'executed', id, tool, ok, verdict: v.verdict, note: v.note, result: String(resultPreview).slice(0, 400) });
  return v;
}

module.exports = { gate, recordResult, verifyResult, audit, MODE, AUDIT, HARD_DENY };
