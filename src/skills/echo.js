// Тестовый скил без LLM — проверка механики флота (очередь, контроль, прогон) без Ollama.
module.exports = {
  name: 'echo',
  async run(payload) {
    return { echo: payload, at: new Date().toISOString() };
  },
};
