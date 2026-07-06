#!/usr/bin/env node
// Селф-тест пайплайна БЕЗ ollama: RAG_FAKE_EMBED=1 (детерминированный хеш-эмбеддинг).
// Проверяет: ingest → search + фильтр приватного (секрет не индексируется). Реальный поиск проверять на ollama.
process.env.RAG_FAKE_EMBED = '1';
process.env.RAG_DB = require('path').join(require('os').tmpdir(), 'rag-selftest-' + Date.now() + '.db');
const { openDb, ingest, search, scanSecret } = require('./lib');

(async () => {
  let ok = true; const A = (c, m) => { console.log((c ? '✅' : '❌') + ' ' + m); if (!c) ok = false; };

  // фильтр приватного
  A(scanSecret('мой redis redis://:hunter2@host:6379 тут'), 'детектит redis-url с паролем');
  A(scanSecret('token=8875080677:AAGflDD0X6u0PN4ICxaCkvRLuwinff0WROw'), 'детектит telegram-токен');
  A(!scanSecret('обычный текст про бекмерж релиза 1.11'), 'обычный текст — не секрет');

  const db = openDb();
  const r = await ingest(db, [
    { scope: 'work', source: 'doc', path: 'backmerge.md', title: 'Backmerge', text: 'Бекмерж release в develop: мерить по diff PR, резолвить submodule к dev-line. 0-change PR валиден.' },
    { scope: 'agent', source: 'sess', path: 's1', title: 'agent-bus', text: 'agent-bus: связь между Claude Code через Redis. presence + inbox durable-лог. Не слать секреты по шине.' },
    { scope: 'personal', source: 'note', path: 'n1', title: 'секрет', text: 'мой bot token=8875080677:AAGflDD0X6u0PN4ICxaCkvRLuwinff0WROw не индексировать' },
  ]);
  A(r.added >= 2, `проиндексировано ${r.added} чанков`);
  A(r.secret >= 1, `секрет отфильтрован (${r.secret})`);

  const res = await search(db, 'как правильно делать бекмерж релиза', { k: 3 });
  A(res.length > 0, 'поиск вернул результаты');
  A(res[0] && /бекмерж/i.test(res[0].text), 'топ-результат релевантен (бекмерж)');

  const res2 = await search(db, 'секретный токен бота', { scope: 'personal', k: 3 });
  A(!res2.some((x) => /8875080677/.test(x.text)), 'секрет НЕ находится (не был проиндексирован)');

  require('fs').rmSync(process.env.RAG_DB, { force: true });
  require('fs').rmSync(process.env.RAG_DB + '-wal', { force: true });
  require('fs').rmSync(process.env.RAG_DB + '-shm', { force: true });
  console.log(ok ? '\n✅ SELFTEST PASSED' : '\n❌ SELFTEST FAILED');
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('ERR', e); process.exit(2); });
