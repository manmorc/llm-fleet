const fs = require('fs');
const path = require('path');

// Реестр скилов: каждый *.js в этой папке (кроме index) экспортирует { name, run(payload, ctx) }.
// Добавить умение всему флоту = добавить файл-скил + `update` (или `reload` для горячей перечитки).
function loadSkills() {
  const reg = {};
  for (const f of fs.readdirSync(__dirname)) {
    if (f === 'index.js' || !f.endsWith('.js')) continue;
    const skill = require(path.join(__dirname, f));
    if (skill && skill.name && typeof skill.run === 'function') reg[skill.name] = skill;
  }
  return reg;
}

let registry = loadSkills();

module.exports = {
  get:  (name) => registry[name],
  list: () => Object.keys(registry),
  // Горячая перечитка скилов без рестарта процесса (по control-команде `reload`)
  reload: () => {
    for (const f of fs.readdirSync(__dirname)) {
      if (f.endsWith('.js') && f !== 'index.js') delete require.cache[require.resolve(path.join(__dirname, f))];
    }
    registry = loadSkills();
    return Object.keys(registry);
  },
};
