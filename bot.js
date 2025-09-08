import 'dotenv/config';
import express from 'express';
import TelegramBot from 'node-telegram-bot-api';
import fetch from 'node-fetch';
import { ChartJSNodeCanvas } from 'chartjs-node-canvas';
import cron from 'node-cron';

// ========================== CONFIG ==========================
const TOKEN = process.env.TOKEN;
if (!TOKEN) throw new Error('❌ Не задано TOKEN у .env');

const USE_WEBHOOK = !!process.env.RENDER_EXTERNAL_URL;
const PORT = process.env.PORT || 3000;
const RENDER_URL = process.env.RENDER_EXTERNAL_URL || null;

// ========================== BOT INIT ==========================
let bot;

if (USE_WEBHOOK) {
  bot = new TelegramBot(TOKEN, { webHook: true });
  bot.setWebHook(`${RENDER_URL}/bot${TOKEN}`);
  console.log('🔹 Bot running in WEBHOOK mode');
} else {
  bot = new TelegramBot(TOKEN, { polling: true });
  console.log('🔹 Bot running in POLLING mode');
}

// ========================== EXPRESS (тільки для webhook) ==========================
if (USE_WEBHOOK) {
  const app = express();
  app.use(express.json());

  // Webhook endpoint
  app.post(`/bot${TOKEN}`, (req, res) => {
    bot.processUpdate(req.body);
    res.sendStatus(200);
  });

  app.get('/', (_, res) => res.send('🤖 Crypto Bot is running'));

  app.listen(PORT, () => console.log(`🚀 Server is running on port ${PORT}`));
}

// ========================== DATA STRUCTURES ==========================
const userJobs = {};
const userCurrencies = {};     // підтверджений вибір
const tempUserCurrencies = {}; // тимчасовий вибір

let topCoins = [];
let lastTopUpdate = 0;
let allCoins = [];
let lastAllUpdate = 0;
const tempUserSchedule = {}; // { chatId: { type: 'everyday' | 'days', days: [], time: null } }
const userSchedule = {};     // остаточний розклад
const chosedActionsTypeOfSettingInterval = {};

// ========================== COINGECKO HELPERS ==========================
async function getTopCoins() {
  const now = Date.now();
  if (topCoins.length && now - lastTopUpdate < 30 * 60 * 1000) return topCoins;

  try {
    const res = await fetch(
      'https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=50&page=1'
    );

    const data = await res.json();

    if (!Array.isArray(data)) {
      console.error('CoinGecko error:', data);
      return topCoins;
    }

    topCoins = data.map(c => ({ id: c.id, symbol: c.symbol, name: c.name }));
    lastTopUpdate = now;
    return topCoins;
  } catch (err) {
    console.error('Помилка отримання топ-50:', err);
    return topCoins;
  }
}

async function getAllCoins() {
  const now = Date.now();
  if (allCoins.length && now - lastAllUpdate < 6 * 60 * 60 * 1000) return allCoins;

  try {
    const res = await fetch('https://api.coingecko.com/api/v3/coins/list');
    const data = await res.json();

    if (!Array.isArray(data)) {
      console.error('CoinGecko error:', data);
      return allCoins;
    }

    allCoins = data;
    lastAllUpdate = now;
    return allCoins;
  } catch (err) {
    console.error('Помилка отримання повного списку:', err);
    return allCoins;
  }
}

async function getCryptoPrices(selectedCurrencies = []) {
  if (!selectedCurrencies.length) {
    return '⚠️ Ти ще не обрав жодної валюти. Використай "Вибрати валюти".';
  }

  const ids = selectedCurrencies.join(',');
  try {
    const res = await fetch(
      `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd&include_24hr_change=true`
    );
    const data = await res.json();

    let prices = '';
    for (const coin of selectedCurrencies) {
      if (data[coin]?.usd === undefined) continue;
      const change = data[coin].usd_24h_change?.toFixed(2);
      prices += `💰 ${coin.toUpperCase()}: ${data[coin].usd}$ (${change}% за 24г)\n`;
    }

    return prices || '❌ Не вдалося отримати курс. Спробуй пізніше.';
  } catch (err) {
    console.error(err);
    return '❌ Помилка при отриманні курсу.';
  }
}

// ========================== CHART ==========================
const chartCanvas = new ChartJSNodeCanvas({ width: 800, height: 400 });

async function getChart(coinId, days) {
  try {
    const res = await fetch(
      `https://api.coingecko.com/api/v3/coins/${coinId}/market_chart?vs_currency=usd&days=${days}`
    );
    const data = await res.json();

    if (!data.prices) {
      console.error('Помилка CoinGecko графік:', data);
      return null;
    }

    const labels = data.prices.map(p => new Date(p[0]).toLocaleDateString());
    const prices = data.prices.map(p => p[1]);

    const config = {
      type: 'line',
      data: { labels, datasets: [{ label: `${coinId.toUpperCase()} (USD)`, data: prices, borderColor: 'blue', fill: false }] },
      options: { responsive: false, plugins: { legend: { display: true } }, scales: { x: { ticks: { maxTicksLimit: 10 } }, y: { beginAtZero: false } } }
    };

    return await chartCanvas.renderToBuffer(config);
  } catch (err) {
    console.error('Помилка отримання графіка:', err);
    return null;
  }
}

// ========================== UI HELPERS ==========================
function getCoinsPage(coins, page = 0, perPage = 10, selected = []) {
  const start = page * perPage;
  const end = start + perPage;
  const pageCoins = coins.slice(start, end);

  const keyboard = pageCoins.map(c => {
    const isSelected = selected.includes(c.id);
    const label = (isSelected ? '✅ ' : '') + `${c.symbol.toUpperCase()} (${c.name})`;
    return [{ text: label, callback_data: `coin_${c.id}` }];
  });

  const navButtons = [];
  if (page > 0) navButtons.push({ text: '⬅️ Назад', callback_data: `page_${page - 1}` });
  if (end < coins.length) navButtons.push({ text: '➡️ Вперед', callback_data: `page_${page + 1}` });
  if (navButtons.length) keyboard.push(navButtons);

  keyboard.push([{ text: '🔎 Пошук', callback_data: 'search' }]);
  keyboard.push([{ text: '✅ Підтвердити', callback_data: 'confirm' }]); // нова кнопка

  return keyboard;
}

async function sendNow(chatId) {
  const selectedCurrencies = userCurrencies[chatId] || [];
  const prices = await getCryptoPrices(selectedCurrencies);
  bot.sendMessage(chatId, prices);
}

function scheduleUserCron(chatId) {
  const sched = userSchedule[chatId];
  if (!sched || !sched.time) return;

  // Видаляємо старі завдання, якщо є
  if (sched.cronJob) sched.cronJob.stop();

  let cronDays = '*'; // за замовчуванням — кожен день
  if (sched.type === 'days' && sched.days.length) {
    // Перетворимо дні у формат cron (0 = Нд, 1 = Пн, … 6 = Сб)
    const dayMap = { 'Нд': 0, 'Пн': 1, 'Вт': 2, 'Ср': 3, 'Чт': 4, 'Пт': 5, 'Сб': 6 };
    cronDays = sched.days.map(d => dayMap[d]).join(',');
  }

  const { h, m, s } = sched.time;
  const cronExpression = `${s} ${m} ${h} * * ${cronDays}`; // s m h * * day_of_week

  const job = cron.schedule(cronExpression, async () => {
    await sendNow(chatId);
  });

  sched.cronJob = job; // зберігаємо об’єкт cronJob, щоб можна було зупинити
  job.start();
}

// ========================== BOT HANDLERS ==========================
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, 'Привіт! Обери дію:', {
    reply_markup: {
      keyboard: [
        ['💰 Отримати курс зараз', '📊 Графік'],
        ['⏱️ Встановити інтервал', '🕒 Встановити час'],
        ['💳 Вибрати валюти'],
      ],
      resize_keyboard: true
    }
  });
});

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text?.trim();

  if (!text) return;

  if (text === '💰 Отримати курс зараз') {
    await sendNow(chatId);
  } else if (text === '⏱️ Встановити інтервал') {
    const selected = userCurrencies[chatId] || [];
    if (!selected.length) return bot.sendMessage(chatId, '⚠️ Ти ще не обрав жодної валюти. Використай "Вибрати валюти".');

    chosedActionsTypeOfSettingInterval[chatId] = 'interval';
    return bot.sendMessage(chatId, 'Введи інтервал у форматі ГГ:ХХ:СС, наприклад 02:30:00.', {
      reply_markup: {
        inline_keyboard: [
          [{ text: '🗑️ Стерти інтервал', callback_data: 'clear_interval' }]
        ]
      }
    });
  } else if (/^\d{1,2}:\d{2}:\d{2}$/.test(text)) {
    const selected = userCurrencies[chatId] || [];
    if (!selected.length) return bot.sendMessage(chatId, '⚠️ Ти ще не обрав жодної валюти. Використай "Вибрати валюти".');

    const [h, m, s] = text.split(':').map(Number);
    if (chosedActionsTypeOfSettingInterval[chatId] === 'interval') {
      // перевірка для інтервалу: мінімум 1 секунда
      if (m >= 60 || s >= 60 || (h === 0 && m === 0 && s === 0)) {
        return bot.sendMessage(chatId, 'Некоректний інтервал. Використовуй формат ГГ:ХХ:СС (мінімум 00:00:01).');
      }

      if (userJobs[chatId]) clearInterval(userJobs[chatId]);
      const intervalMs = (h * 3600 + m * 60 + s) * 1000;
      userJobs[chatId] = setInterval(() => sendNow(chatId), intervalMs);
      return bot.sendMessage(chatId, `⏱️ Розсилка по інтервалу буде надсилатися кожні ${text}`);
    }
    if (chosedActionsTypeOfSettingInterval[chatId] === 'schedule') {
      if (h > 23 || m > 59 || s > 59) {
        return bot.sendMessage(chatId, 'Некоректний час. Максимум 23:59:59');
      }

      tempUserSchedule[chatId].time = { h, m, s };
      userSchedule[chatId] = { ...tempUserSchedule[chatId] };
      delete tempUserSchedule[chatId];

      scheduleUserCron(chatId); // <- тут запускаємо cron

      return bot.sendMessage(
        chatId,
        `🕒 Розсилка запланована: ${userSchedule[chatId].type === 'everyday' ? 'кожен день' : userSchedule[chatId].days.join(', ')} о ${text}`
      );
    }

    // очистка стану після обробки
    delete chosedActionsTypeOfSettingInterval[chatId];
  } else if (text === '💳 Вибрати валюти') {
    const coins = await getTopCoins();
    tempUserCurrencies[chatId] = [...(userCurrencies[chatId] || [])]; // робимо копію
    const selected = tempUserCurrencies[chatId];
    const keyboard = getCoinsPage(coins, 0, 10, selected);
    bot.sendMessage(chatId, 'ТОП-50 валют за капіталізацією:', { reply_markup: { inline_keyboard: keyboard } });
  } else if (text === '📊 Графік') {
    const selected = userCurrencies[chatId] || [];
    if (!selected.length) return bot.sendMessage(chatId, '⚠️ Ти ще не обрав жодної валюти. Використай "Вибрати валюти".');
    const keyboard = selected.map(coinId => ([{ text: coinId.toUpperCase(), callback_data: `chooseChart_${coinId}` }]));
    bot.sendMessage(chatId, 'Оберіть валюту для графіка:', { reply_markup: { inline_keyboard: keyboard } });
  } else if (text === '🕒 Встановити час') {
    const selected = userCurrencies[chatId] || [];
    if (!selected.length) return bot.sendMessage(chatId, '⚠️ Ти ще не обрав жодної валюти. Використай "Вибрати валюти".');

    chosedActionsTypeOfSettingInterval[chatId] = 'schedule';
    tempUserSchedule[chatId] = { type: null, days: [], time: null };
    return bot.sendMessage(chatId, 'Обери тип розсилки:', {
      reply_markup: {
        inline_keyboard: [
          [{ text: '📅 Кожен день', callback_data: 'schedule_everyday' }],
          [{ text: '🗓️ Вибрати дні', callback_data: 'schedule_days' }],
          [{ text: '🗑️ Стерти розклад', callback_data: 'delete_schedule' }]
        ]
      }
    });
  }
});

bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;

  // --- Pagination
  if (data.startsWith('page_')) {
    const page = parseInt(data.split('_')[1], 10);
    const coins = await getTopCoins();
    const selected = tempUserCurrencies[chatId] || [];
    const keyboard = getCoinsPage(coins, page, 10, selected);
    return bot.editMessageReplyMarkup({ inline_keyboard: keyboard }, { chat_id: chatId, message_id: query.message.message_id });
  }

  // --- Select coin (тимчасово)
  if (data.startsWith('coin_')) {
    const coinId = data.split('_')[1];
    if (!tempUserCurrencies[chatId]) tempUserCurrencies[chatId] = [];
    const arr = tempUserCurrencies[chatId];
    if (!arr.includes(coinId)) arr.push(coinId);
    else arr.splice(arr.indexOf(coinId), 1);

    const coins = await getTopCoins();
    const selected = tempUserCurrencies[chatId];
    const keyboard = getCoinsPage(coins, 0, 10, selected);

    bot.editMessageReplyMarkup({ inline_keyboard: keyboard }, { chat_id: chatId, message_id: query.message.message_id });
    return bot.answerCallbackQuery(query.id, { text: `Обрано: ${arr.map(c => c.toUpperCase()).join(', ') || 'нічого'}` });
  }

  // --- Confirm selection
  if (data === 'confirm') {
    userCurrencies[chatId] = [...(tempUserCurrencies[chatId] || [])];
    delete tempUserCurrencies[chatId];
    await bot.answerCallbackQuery(query.id, { text: '✅ Збережено вибір!' });
    await sendNow(chatId);
    return;
  }

  // --- Search
  if (data === 'search') {
    bot.sendMessage(chatId, 'Введіть назву або символ монети:');
    return bot.once('message', async (msg) => {
      const text = msg.text.toLowerCase();
      const coins = await getAllCoins();
      const filtered = coins.filter(c => c.symbol.toLowerCase().includes(text) || c.name.toLowerCase().includes(text)).slice(0, 20);
      if (!filtered.length) return bot.sendMessage(chatId, 'Нічого не знайдено 😔');
      const selected = tempUserCurrencies[chatId] || [];
      const keyboard = getCoinsPage(filtered, 0, 10, selected);
      bot.sendMessage(chatId, `Результати пошуку для "${text}":`, { reply_markup: { inline_keyboard: keyboard } });
    });
  }

  // --- Choose chart coin
  if (data.startsWith('chooseChart_')) {
    const coinId = data.split('_')[1];
    return bot.sendMessage(chatId, `Оберіть період для ${coinId.toUpperCase()}:`, {
      reply_markup: {
        inline_keyboard: [[
          { text: '7 днів', callback_data: `chart_${coinId}_7` },
          { text: '30 днів', callback_data: `chart_${coinId}_30` },
          { text: '1 рік', callback_data: `chart_${coinId}_365` }
        ]]
      }
    });
  }

  // --- Show chart
  if (data.startsWith('chart_')) {
    const [_, coinId, days] = data.split('_');
    bot.answerCallbackQuery(query.id, { text: `Будую графік для ${coinId}...` });
    const image = await getChart(coinId, days);
    if (image) return bot.sendPhoto(chatId, image, { caption: `📊 ${coinId.toUpperCase()} за ${days} днів` });
    bot.sendMessage(chatId, '❌ Не вдалося побудувати графік.');
  }

  // --- Clear Interval
  if (data === 'clear_interval') {
    if (userJobs[chatId]) {
      clearInterval(userJobs[chatId]);
      delete userJobs[chatId];
      await bot.answerCallbackQuery(query.id, { text: '⏹️ Інтервал видалено' });
      await bot.sendMessage(chatId, 'Розсилка по інтервалу більше не надсилається.');
    } else {
      await bot.answerCallbackQuery(query.id, { text: '⚠️ Інтервалу не було' });
    }
  }

  // --- Стерти розклад
  if (data === 'delete_schedule') {
    if (userSchedule[chatId]) {
      // зупиняємо cron, якщо є
      if (userSchedule[chatId].cronJob) {
        userSchedule[chatId].cronJob.stop();
      }
      delete userSchedule[chatId];
      delete tempUserSchedule[chatId];
      delete chosedActionsTypeOfSettingInterval[chatId];

      await bot.answerCallbackQuery(query.id, { text: '🗑️ Розклад видалено' });
      return bot.sendMessage(chatId, 'Розсилка за розкладом більше не надсилається.');
    } else {
      await bot.answerCallbackQuery(query.id, { text: '⚠️ Розкладу не було' });
    }
  }

});
// --- Обробка callback_query для розкладу
bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;

  if (!tempUserSchedule[chatId]) tempUserSchedule[chatId] = { type: null, days: [], time: null };

  // --- Кожен день
  if (data === 'schedule_everyday') {
    tempUserSchedule[chatId].type = 'everyday';
    await bot.answerCallbackQuery(query.id, { text: 'Обрано: Кожен день' });
    await bot.sendMessage(chatId, 'Введи час для розсилки у форматі ГГ:ХХ:СС, наприклад 09:00:00');
  }

  // --- Вибір днів
  if (data === 'schedule_days') {
    tempUserSchedule[chatId].type = 'days';
    const daysButtons = [
      ['Пн', 'Вт', 'Ср'],
      ['Чт', 'Пт', 'Сб'],
      ['Нд']
    ].map(row => row.map(day => ({ text: day, callback_data: `day_${day}` })));
    daysButtons.push([{ text: '✅ Підтвердити дні', callback_data: 'confirm_days' }]);
    await bot.answerCallbackQuery(query.id, { text: 'Обрано: Вибір днів' });
    await bot.sendMessage(chatId, 'Оберіть дні для розсилки:', { reply_markup: { inline_keyboard: daysButtons } });
  }

  // --- Вибір днів мультивибір
  if (data.startsWith('day_')) {
    const day = data.split('_')[1];
    const daysArr = tempUserSchedule[chatId].days;
    if (daysArr.includes(day)) daysArr.splice(daysArr.indexOf(day), 1);
    else daysArr.push(day);
    await bot.answerCallbackQuery(query.id, { text: `Обрано днів: ${daysArr.join(', ') || 'нічого'}` });
  }

  // --- Підтвердити дні
  if (data === 'confirm_days') {
    if (!tempUserSchedule[chatId].days.length) {
      return bot.answerCallbackQuery(query.id, { text: '⚠️ Оберіть хоча б один день' });
    }
    await bot.answerCallbackQuery(query.id, { text: 'Дні збережено' });
    await bot.sendMessage(chatId, 'Введи час для розсилки у форматі ГГ:ХХ:СС, наприклад 09:00:00');
  }
});