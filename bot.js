import 'dotenv/config';
import TelegramBot from 'node-telegram-bot-api';
import fetch from 'node-fetch';
import { ChartJSNodeCanvas } from 'chartjs-node-canvas';

const TOKEN = process.env.TOKEN || 'ТВОЙ_API_TOKEN';
const bot = new TelegramBot(TOKEN, { polling: true });

const userJobs = {};
const userCurrencies = {};

let test = null
let topCoins = [];
let lastTopUpdate = 0;
let allCoins = [];
let lastAllUpdate = 0;

async function getTopCoins() {
  const now = Date.now();
  if (topCoins.length && now - lastTopUpdate < 30 * 60 * 1000) return topCoins;
  try {
    const res = await fetch(
      'https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=50&page=1'
    );
    const data = await res.json();
    topCoins = data.map(c => ({ id: c.id, symbol: c.symbol, name: c.name }));
    lastTopUpdate = now;
    return topCoins;
  } catch (err) {
    console.error('Помилка отримання топ-50:', err);
    return [];
  }
}

async function getAllCoins() {
  const now = Date.now();
  if (allCoins.length && now - lastAllUpdate < 6 * 60 * 60 * 1000) return allCoins;
  try {
    const res = await fetch('https://api.coingecko.com/api/v3/coins/list');
    const data = await res.json();
    allCoins = data;
    lastAllUpdate = now;
    return allCoins;
  } catch (err) {
    console.error('Помилка отримання повного списку:', err);
    return [];
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

    if (!prices) return '❌ Не вдалося отримати курс. Спробуй пізніше.';
    return prices;
  } catch (err) {
    console.error(err);
    return '❌ Помилка при отриманні курсу.';
  }
}

// ========================== Графік ==========================
const chartCanvas = new ChartJSNodeCanvas({ width: 800, height: 400 });

async function getChart(coinId, days) {
  try {
    const res = await fetch(
      `https://api.coingecko.com/api/v3/coins/${coinId}/market_chart?vs_currency=usd&days=${days}`
    );
    const data = await res.json();

    const labels = data.prices.map(p => new Date(p[0]).toLocaleDateString());
    const prices = data.prices.map(p => p[1]);

    const config = {
      type: 'line',
      data: {
        labels,
        datasets: [
          {
            label: `${coinId.toUpperCase()} (USD)`,
            data: prices,
            borderColor: 'blue',
            fill: false,
          },
        ],
      },
      options: {
        responsive: false,
        plugins: { legend: { display: true } },
        scales: {
          x: { ticks: { maxTicksLimit: 10 } },
          y: { beginAtZero: false },
        },
      },
    };

    const image = await chartCanvas.renderToBuffer(config);
    return image;
  } catch (err) {
    console.error('Помилка отримання графіка:', err);
    return null;
  }
}

// ========================== UI ==========================
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

  return keyboard;
}

async function sendNow(chatId) {
  const selectedCurrencies = userCurrencies[chatId] || [];
  const prices = await getCryptoPrices(selectedCurrencies);
  bot.sendMessage(chatId, prices);
  console.log(`Відправлено курс користувачу ${chatId}`);
}

// ========================== BOT ==========================
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, 'Привіт! Обери дію:', {
    reply_markup: {
      keyboard: [
        ['Отримати курс зараз', 'Встановити інтервал'],
        ['Вибрати валюти', '📊 Графік']
      ],
      resize_keyboard: true
    }
  });
});

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text.trim();

  if (text === 'Отримати курс зараз') {
    await sendNow(chatId);

  } else if (text === 'Встановити інтервал') {
    bot.sendMessage(chatId, 'Введи інтервал у форматі ГГ:ХХ:СС, наприклад 02:30:00');

  } else if (/^\d{1,2}:\d{2}:\d{2}$/.test(text)) {
    const [h, m, s] = text.split(':').map(Number);
    if (h >= 24 || m >= 60 || s >= 60) {
      bot.sendMessage(chatId, 'Некоректний час. Використовуй формат ГГ:ХХ:СС');
      return;
    }
    if (userJobs[chatId]) clearInterval(userJobs[chatId]);
    const intervalMs = ((h * 3600 + m * 60 + s) * 1000);
    userJobs[chatId] = setInterval(() => sendNow(chatId), intervalMs);
    bot.sendMessage(chatId, `Розсилка буде надсилатися кожні ${text} (ГГ:ХХ:СС)`);

  } else if (text === 'Вибрати валюти') {
    const coins = await getTopCoins();
    const selected = userCurrencies[chatId] || [];
    const keyboard = getCoinsPage(coins, 0, 10, selected);

    bot.sendMessage(chatId, 'ТОП-50 валют за капіталізацією:', {
      reply_markup: { inline_keyboard: keyboard }
    });

  } else if (text === '📊 Графік') {
    const selected = userCurrencies[chatId] || [];
    if (!selected.length) {
      bot.sendMessage(chatId, '⚠️ Спочатку вибери хоча б одну валюту.');
      return;
    }

    // Клавіатура з вибраними валютами
    const keyboard = selected.map(coinId => ([
      { text: coinId.toUpperCase(), callback_data: `chooseChart_${coinId}` }
    ]));

    bot.sendMessage(chatId, 'Оберіть валюту для графіка:', {
      reply_markup: { inline_keyboard: keyboard }
    });
  }
});

bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;

  if (data.startsWith('page_')) {
    const page = parseInt(data.split('_')[1], 10);
    const coins = await getTopCoins();
    const selected = userCurrencies[chatId] || [];
    const keyboard = getCoinsPage(coins, page, 10, selected);

    bot.editMessageReplyMarkup(
      { inline_keyboard: keyboard },
      { chat_id: chatId, message_id: query.message.message_id }
    );
    return;
  }

  if (data.startsWith('coin_')) {
    const coinId = data.split('_')[1];
    if (!userCurrencies[chatId]) userCurrencies[chatId] = [];
    const arr = userCurrencies[chatId];

    if (!arr.includes(coinId)) arr.push(coinId);
    else arr.splice(arr.indexOf(coinId), 1);

    const coins = await getTopCoins();
    const selected = userCurrencies[chatId];
    const keyboard = getCoinsPage(coins, 0, 10, selected);

    bot.editMessageReplyMarkup(
      { inline_keyboard: keyboard },
      { chat_id: chatId, message_id: query.message.message_id }
    );

    bot.answerCallbackQuery(query.id, {
      text: `Вибрані: ${arr.map(c => c.toUpperCase()).join(', ') || 'нічого'}`
    });
    return;
  }

  if (data === 'search') {
    bot.sendMessage(chatId, 'Введіть назву або символ монети:');
    bot.once('message', async (msg) => {
      const text = msg.text.toLowerCase();
      const coins = await getAllCoins();
      const filtered = coins.filter(c =>
        c.symbol.toLowerCase().includes(text) || c.name.toLowerCase().includes(text)
      ).slice(0, 20);

      if (!filtered.length) {
        bot.sendMessage(chatId, 'Нічого не знайдено 😔');
        return;
      }

      const selected = userCurrencies[chatId] || [];
      const keyboard = getCoinsPage(filtered, 0, 10, selected);
      bot.sendMessage(chatId, `Результати пошуку для "${text}":`, {
        reply_markup: { inline_keyboard: keyboard }
      });
    });
    return;
  }

  if (data.startsWith('chooseChart_')) {
    const coinId = data.split('_')[1];

    bot.sendMessage(chatId, `Оберіть період для ${coinId.toUpperCase()}:`, {
      reply_markup: {
        inline_keyboard: [
          [
            { text: '7 днів', callback_data: `chart_${coinId}_7` },
            { text: '30 днів', callback_data: `chart_${coinId}_30` },
            { text: '1 рік', callback_data: `chart_${coinId}_365` }
          ]
        ]
      }
    });
    return;
  }

  if (data.startsWith('chart_')) {
    const [_, coinId, days] = data.split('_');
    bot.answerCallbackQuery(query.id, { text: `Будую графік для ${coinId}...` });

    const image = await getChart(coinId, days);
    if (image) {
      bot.sendPhoto(chatId, image, { caption: `📊 ${coinId.toUpperCase()} за ${days} днів` });
    } else {
      bot.sendMessage(chatId, '❌ Не вдалося побудувати графік.');
    }
    return;
  }
});
