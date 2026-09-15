#!/usr/bin/env node
// Проверка ключа Nous Portal: что доступно, жив ли эндпоинт, с какой скоростью отвечает.
// Запуск:  node cloud/nous-smoke.js [имя-модели]
// Ключ берётся из cloud/.env (NOUS_API_KEY=sk-nous-...).
//
// Меряем два числа отдельно, потому что они про разное:
//   TTFT  — сколько ждать ПЕРВОГО токена (префилл + сеть). Это ощущение отзывчивости.
//   ток/с — скорость генерации после старта. Это время до конца длинного ответа.
'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');

const BASE = 'https://inference-api.nousresearch.com/v1';
const MODEL = process.argv[2] || 'Hermes-4-405B';

function loadKey() {
  const envFile = path.join(__dirname, '.env');
  if (fs.existsSync(envFile)) {
    for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*NOUS_API_KEY\s*=\s*(.+?)\s*$/);
      if (m) return m[1];
    }
  }
  return process.env.NOUS_API_KEY || null;
}

function request(method, urlPath, key, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(BASE + urlPath);
    const payload = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: url.hostname,
      path: url.pathname + url.search,
      method,
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
      timeout: 180000,
    }, (res) => resolve(res));
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('таймаут 180с')));
    if (payload) req.write(payload);
    req.end();
  });
}

function drain(res) {
  return new Promise((resolve) => {
    let d = '';
    res.on('data', (c) => (d += c));
    res.on('end', () => resolve(d));
  });
}

async function listModels(key) {
  const res = await request('GET', '/models', key);
  const raw = await drain(res);
  if (res.statusCode !== 200) {
    throw new Error(`/models вернул HTTP ${res.statusCode}: ${raw.slice(0, 300)}`);
  }
  const data = JSON.parse(raw).data || [];
  return data.map((m) => m.id);
}

async function timedStream(key, model) {
  const t0 = Date.now();
  let tFirst = null;
  let tokens = 0;
  let text = '';

  const res = await request('POST', '/chat/completions', key, {
    model,
    stream: true,
    max_tokens: 400,
    temperature: 0.3,
    messages: [{
      role: 'user',
      content: 'Кратко, по-русски: чем разреженная MoE-модель отличается от плотной с точки зрения скорости вывода? 4-5 предложений.',
    }],
  });

  if (res.statusCode !== 200) {
    const raw = await drain(res);
    throw new Error(`HTTP ${res.statusCode}: ${raw.slice(0, 400)}`);
  }

  await new Promise((resolve, reject) => {
    let buf = '';
    res.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') continue;
        let j;
        try { j = JSON.parse(payload); } catch { continue; }
        const d = j.choices && j.choices[0] && j.choices[0].delta;
        if (!d) continue;
        // gpt-oss и родня кладут размышление в отдельный канал — считаем и его,
        // иначе получим ложные «0 токенов» на думающей модели.
        const piece = d.content || d.reasoning_content || '';
        if (piece) {
          if (tFirst === null) tFirst = Date.now();
          tokens++;
          text += d.content || '';
        }
      }
    });
    res.on('end', resolve);
    res.on('error', reject);
  });

  const total = (Date.now() - t0) / 1000;
  const ttft = tFirst ? (tFirst - t0) / 1000 : null;
  const genSec = tFirst ? (Date.now() - tFirst) / 1000 : null;
  return { total, ttft, tokens, tps: genSec > 0 ? tokens / genSec : null, text };
}

(async () => {
  const key = loadKey();
  if (!key) {
    console.error('Нет ключа. Добавь NOUS_API_KEY=sk-nous-... в cloud/.env');
    process.exit(2);
  }
  console.log(`Ключ: ${key.slice(0, 12)}…${key.slice(-4)}  |  модель: ${MODEL}\n`);

  console.log('— Доступные модели —');
  let ids = [];
  try {
    ids = await listModels(key);
    console.log(`  всего: ${ids.length}`);
    const hermes = ids.filter((i) => /hermes/i.test(i));
    if (hermes.length) console.log('  Hermes:', hermes.join(', '));
    const notable = ids.filter((i) => /claude|gpt-5|gemini|deepseek|qwen/i.test(i)).slice(0, 12);
    if (notable.length) console.log('  прочее (первые 12):', notable.join(', '));
    if (!ids.includes(MODEL)) {
      console.log(`\n  ВНИМАНИЕ: "${MODEL}" в списке нет. Точное имя ищи выше.`);
    }
  } catch (e) {
    console.log('  не удалось получить список:', e.message);
  }

  console.log('\n— Замер —');
  try {
    const r = await timedStream(key, MODEL);
    console.log(`  TTFT (первый токен): ${r.ttft === null ? 'н/д' : r.ttft.toFixed(2) + ' с'}`);
    console.log(`  скорость генерации : ${r.tps === null ? 'н/д' : r.tps.toFixed(1) + ' ток/с'}`);
    console.log(`  токенов / всего    : ${r.tokens} за ${r.total.toFixed(1)} с`);
    console.log('\n— Ответ —');
    console.log(r.text.trim().slice(0, 900) || '(пусто)');
  } catch (e) {
    console.error('  ОШИБКА:', e.message);
    process.exit(1);
  }
})();
