#!/usr/bin/env node
// Прогон скила ЛОКАЛЬНО, без Redis/очереди — для отладки скилов и быстрой проверки.
//   node src/run-skill.js echo '{"text":"hi"}'
//   node src/run-skill.js parseSignal '{"text":"BTC long entry 65000 sl 63000 tp 70000"}'
const skills = require('./skills');
const { chat } = require('./ollama');

const [, , name, json] = process.argv;
(async () => {
  const skill = skills.get(name);
  if (!skill) { console.error('нет такого скила. доступны:', skills.list().join(', ')); process.exit(1); }
  let payload; try { payload = json ? JSON.parse(json) : {}; } catch (_) { payload = json; }
  const out = await skill.run(payload, { chat });
  console.log(JSON.stringify(out, null, 2));
  process.exit(0);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
