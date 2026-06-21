const IORedis = require('ioredis');
const { spawn } = require('child_process');
const path = require('path');
const cfg = require('./config');
const skills = require('./skills');

// Управляющая плоскость: подписка на Redis pub/sub. Команды шлёт `fleet broadcast <cmd>`.
// Поддержка адресной доставки (msg.target) и broadcast (без target).
function setupControl(worker, { heartbeat }) {
  const sub = new IORedis(cfg.redisUrl, { maxRetriesPerRequest: null });
  sub.subscribe(cfg.controlChannel).catch((e) => console.error('[control] subscribe err', e.message));

  sub.on('message', async (_ch, raw) => {
    let msg; try { msg = JSON.parse(raw); } catch (_) { return; }
    if (msg.target && msg.target !== cfg.workerId) return; // не мне
    const { cmd, args = {} } = msg;
    console.log(`[control] ${cmd}`, Object.keys(args).length ? JSON.stringify(args) : '');
    try {
      switch (cmd) {
        case 'ping':   await heartbeat(); break;
        case 'reload': skills.reload(); await heartbeat(); break;       // горячая перечитка скилов
        case 'drain':  await worker.pause(); await heartbeat(); break;  // доделать текущее, новые не брать
        case 'resume': worker.resume(); await heartbeat(); break;
        case 'set-model':
          if (args.model) {
            cfg.model = args.model;
            spawn('bash', ['-c', `ollama pull ${args.model}`], { detached: true, stdio: 'ignore' }).unref();
            await heartbeat();
          }
          break;
        case 'update': // git pull + npm i + pm2 restart — ОТВЯЗАННЫМ процессом (переживёт рестарт воркера)
          spawn('bash', [path.join(cfg.repoDir, 'update.sh')], {
            cwd: cfg.repoDir, detached: true, stdio: 'ignore',
            env: { ...process.env, PM2_NAME: cfg.pm2Name },
          }).unref();
          break;
        case 'rollback': // откат на git-ref: broadcast rollback {"ref":"<tag|hash>"}
          if (args.ref) {
            spawn('bash', ['-c', `cd ${cfg.repoDir} && git checkout ${args.ref} && npm install --omit=dev && pm2 restart ${cfg.pm2Name}`],
              { detached: true, stdio: 'ignore' }).unref();
          }
          break;
        default: console.warn('[control] неизвестная команда:', cmd);
      }
    } catch (e) { console.error('[control] err', e.message); }
  });

  return sub;
}

module.exports = { setupControl };
