// ДИНАМИЧЕСКИЕ СКИЛЫ АГЕНТА: инструменты, добавленные после сборки образа.
//
// 🔒 РАЗДЕЛЕНИЕ, БЕЗ КОТОРОГО ВСЁ ЛОМАЕТСЯ. Агент может ПРЕДЛОЖИТЬ скил (тул skill_propose пишет
// в staging), но НЕ может его подключить. Загружается только то, что лежит в agent/skills/ —
// а туда кладёт человек/надзор после ревью. Причина простая: скил объявляет сам себя `safe`,
// то есть проходит МИМО гейта надзора. Агент, регистрирующий себе скилы, за один ход выписал бы
// себе `safe: true` обёртку над shell и обнулил бы весь надзор. Поэтому путь ровно один:
//   агент → ~/.agent-bus/proposed-skills/<имя>.js  (НЕ исполняется, просто текст)
//   ревью → agent/skills/<имя>.js                  (подхватится при следующем старте)
//
// Формат скила — тот же, что у встроенных тулзов в tools.js:
//   module.exports = { name, description, schema, safe, run: async (args) => '...' };
const fs = require('fs');
const path = require('path');

const SKILLS_DIR = path.join(__dirname, 'skills');

// Никогда не роняет агента: битый скил пропускаем с записью в stderr, остальные грузим.
// Иначе одна опечатка в предложенном скиле убивала бы весь сервис при старте.
function load() {
  const out = {};
  let files = [];
  try { files = fs.readdirSync(SKILLS_DIR).filter((f) => f.endsWith('.js')); } catch (_) { return out; }
  for (const f of files) {
    const p = path.join(SKILLS_DIR, f);
    try {
      const s = require(p);
      if (!s || !s.name || typeof s.run !== 'function' || !s.schema) {
        process.stderr.write(`[скилы] пропущен ${f}: нужны поля name, schema, run()\n`);
        continue;
      }
      out[s.name] = {
        safe: s.safe === true,                       // по умолчанию РИСКОВЫЙ: тихо мимо надзора не проходим
        schema: s.schema,
        description: s.description || s.name,
        run: s.run,
        _dynamic: f,
      };
    } catch (e) {
      process.stderr.write(`[скилы] ошибка в ${f}: ${e.message}\n`);
    }
  }
  return out;
}

module.exports = { load, SKILLS_DIR };
