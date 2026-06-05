const { Telegraf, Markup } = require('telegraf');
const jalaali = require('jalaali-js');
const logger = require('./logger');
const { createAlert, deleteAlert, loadAlerts, updateAlert } = require('./configManager');
const { checkAlert } = require('./scheduler');
const origins = require('../config/origins.json');
const destinations = require('../config/destinations.json');
const providers = require('../config/providers.json');

const BOT_TOKEN = process.env.BOT_TOKEN;
const states = new Map();
const DELETE_MESSAGES_AFTER_SECONDS = Math.max(0, Number(process.env.DELETE_MESSAGES_AFTER_SECONDS || 300));

const transports = {
  flight: 'هواپیما',
  train: 'قطار',
  bus: 'اتوبوس'
};

const mainMenu = Markup.keyboard([
  ['هشدار جدید'],
  ['هشدارهای من']
]).resize();

function scheduleMessageDeletion(bot, chatId, messageId) {
  if (!DELETE_MESSAGES_AFTER_SECONDS || !chatId || !messageId) return;
  setTimeout(() => {
    bot.telegram.deleteMessage(chatId, messageId).catch((error) => {
      logger.warn('Could not delete message ' + messageId + ' in chat ' + chatId + ': ' + error.message);
    });
  }, DELETE_MESSAGES_AFTER_SECONDS * 1000);
}

function installAutoDelete(bot) {
  bot.use(async (ctx, next) => {
    if (!ctx.chat || !ctx.reply) return next();
    const originalReply = ctx.reply.bind(ctx);
    ctx.reply = async (...args) => {
      const sent = await originalReply(...args);
      if (sent?.message_id) scheduleMessageDeletion(bot, ctx.chat.id, sent.message_id);
      return sent;
    };
    return next();
  });
}

async function sendManagedMessage(bot, chatId, text, extra) {
  const sent = await bot.telegram.sendMessage(chatId, text, extra);
  if (sent?.message_id) scheduleMessageDeletion(bot, chatId, sent.message_id);
  return sent;
}

const monthNames = [
  'فروردین',
  'اردیبهشت',
  'خرداد',
  'تیر',
  'مرداد',
  'شهریور',
  'مهر',
  'آبان',
  'آذر',
  'دی',
  'بهمن',
  'اسفند'
];

function formatPrice(value) {
  return Math.round(value).toLocaleString('fa-IR') + ' تومان';
}

function rows(buttons, size = 2) {
  const out = [];
  for (let i = 0; i < buttons.length; i += size) out.push(buttons.slice(i, i + size));
  return out;
}

function navRows() {
  return [
    [
      Markup.button.callback('هشدار جدید', 'menu:new'),
      Markup.button.callback('هشدارهای من', 'menu:alerts')
    ]
  ];
}

function keyboardFromMap(items, prefix) {
  const buttons = Object.entries(items).map(([label, code]) =>
    Markup.button.callback(label, prefix + ':' + code)
  );
  return Markup.inlineKeyboard([...rows(buttons, 2), ...navRows()]);
}

function transportKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('هواپیما', 'transport:flight'),
      Markup.button.callback('قطار', 'transport:train')
    ],
    [Markup.button.callback('اتوبوس', 'transport:bus')],
    ...navRows()
  ]);
}

function hasActiveProvider(transport) {
  return providers.some((provider) =>
    provider.enabled !== false && (!provider.transports || provider.transports.includes(transport))
  );
}

function passengerKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('۱ نفر', 'passengers:1'),
      Markup.button.callback('۲ نفر', 'passengers:2'),
      Markup.button.callback('۳ نفر', 'passengers:3')
    ],
    [
      Markup.button.callback('۴ نفر', 'passengers:4'),
      Markup.button.callback('۵ نفر', 'passengers:5'),
      Markup.button.callback('۶ نفر', 'passengers:6')
    ],
    ...navRows()
  ]);
}

function modeKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('هوشمند با تاریخچه قیمت', 'mode:smart')],
    [Markup.button.callback('زیر مبلغ مشخص', 'mode:threshold')],
    ...navRows()
  ]);
}

function thresholdKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('۲ میلیون', 'threshold:2000000'),
      Markup.button.callback('۳ میلیون', 'threshold:3000000')
    ],
    [
      Markup.button.callback('۵ میلیون', 'threshold:5000000'),
      Markup.button.callback('۱۰ میلیون', 'threshold:10000000')
    ],
    [Markup.button.callback('مبلغ دلخواه', 'threshold:custom')],
    ...navRows()
  ]);
}

function currentJalaliYear() {
  const now = new Date();
  return jalaali.toJalaali(now.getFullYear(), now.getMonth() + 1, now.getDate()).jy;
}

function yearKeyboard() {
  const jy = currentJalaliYear();
  return Markup.inlineKeyboard([
    [
      Markup.button.callback(String(jy), 'date-year:' + jy),
      Markup.button.callback(String(jy + 1), 'date-year:' + (jy + 1)),
      Markup.button.callback(String(jy + 2), 'date-year:' + (jy + 2))
    ],
    ...navRows()
  ]);
}

function monthKeyboard() {
  const buttons = monthNames.map((name, index) =>
    Markup.button.callback(name, 'date-month:' + (index + 1))
  );
  return Markup.inlineKeyboard([...rows(buttons, 3), ...navRows()]);
}

function dayKeyboard(year, month) {
  const count = jalaali.jalaaliMonthLength(Number(year), Number(month));
  const buttons = [];
  for (let day = 1; day <= count; day += 1) {
    buttons.push(Markup.button.callback(String(day), 'date-day:' + day));
  }
  return Markup.inlineKeyboard([...rows(buttons, 7), ...navRows()]);
}

function cityNameByCode(map, code) {
  return Object.entries(map).find(([, value]) => value === code)?.[0] || code;
}

function setStep(chatId, patch) {
  const current = states.get(String(chatId)) || {};
  states.set(String(chatId), { ...current, ...patch });
}

function getStep(chatId) {
  return states.get(String(chatId));
}

function clearStep(chatId) {
  states.delete(String(chatId));
}

function toGregorianDateString(jy, jm, jd) {
  const g = jalaali.toGregorian(Number(jy), Number(jm), Number(jd));
  const mm = String(g.gm).padStart(2, '0');
  const dd = String(g.gd).padStart(2, '0');
  return g.gy + '-' + mm + '-' + dd;
}

function buildSummary(alert) {
  const originName = alert.originName || cityNameByCode(origins, alert.origin);
  const destinationName = alert.destinationName || cityNameByCode(destinations, alert.destination);
  const startDate = alert.jalaliDate || alert.date;
  const endDate = alert.jalaliEndDate || alert.endDate || startDate;
  const dateLine = startDate === endDate ? startDate : startDate + ' تا ' + endDate;
  const lines = [
    'هشدار ذخیره شد.',
    '',
    'شناسه: ' + alert.id,
    'نوع سفر: ' + transports[alert.transport],
    'مسیر: ' + originName + ' به ' + destinationName,
    'بازه سفر: ' + dateLine,
    'تعداد مسافر: ' + alert.passengers,
    'حالت: ' + (alert.mode === 'threshold' ? 'زیر مبلغ مشخص' : 'هوشمند بر اساس تاریخچه قیمت')
  ];
  if (alert.mode === 'threshold') lines.push('مبلغ هدف: ' + formatPrice(alert.thresholdPrice));
  return lines.join('\n');
}

function persistAlert(chatId, state, patch = {}) {
  const input = { ...state, ...patch };
  delete input.step;
  if (input.editingId) {
    const id = input.editingId;
    delete input.editingId;
    return updateAlert(id, {
      ...input,
      enabled: true,
      updatedAt: new Date().toISOString(),
      lastProviderWarningAt: null,
      lastNoTicketWarningAt: null,
      lastBaselineMessageAt: null
    });
  }
  delete input.editingId;
  return createAlert(chatId, input);
}

async function saveAndCheck(ctx, alert) {
  if (!alert) return ctx.reply('درخواست پیدا نشد.', mainMenu);
  await ctx.reply(buildSummary(alert), mainMenu);
  await checkAlert({ telegram: ctx.telegram }, alert, providers);
}

function listAlertsText(chatId) {
  const alerts = Object.values(loadAlerts()).filter((alert) => String(alert.chatId) === String(chatId));
  if (!alerts.length) return 'هنوز هشداری ثبت نشده است.';
  return alerts.map((alert) => {
    const originName = alert.originName || cityNameByCode(origins, alert.origin);
    const destinationName = alert.destinationName || cityNameByCode(destinations, alert.destination);
    return [
      (alert.enabled ? 'فعال' : 'غیرفعال') + ' | ' + alert.id,
      transports[alert.transport] + ' | ' + originName + ' به ' + destinationName,
      'بازه سفر: ' + ((alert.jalaliEndDate && alert.jalaliEndDate !== alert.jalaliDate) ? (alert.jalaliDate + ' تا ' + alert.jalaliEndDate) : (alert.jalaliDate || alert.date)),
      'حالت: ' + (alert.mode === 'threshold' ? 'زیر ' + formatPrice(alert.thresholdPrice) : 'هوشمند')
    ].join('\n');
  }).join('\n\n');
}

async function sendAlertsList(ctx) {
  const alerts = Object.values(loadAlerts()).filter((alert) => String(alert.chatId) === String(ctx.chat.id));
  if (!alerts.length) return ctx.reply('هنوز هشداری ثبت نشده است.', mainMenu);

  for (const alert of alerts) {
    await ctx.reply(buildSummary(alert), Markup.inlineKeyboard([
      [
        Markup.button.callback('ویرایش', 'alert-edit:' + alert.id),
        Markup.button.callback('حذف', 'alert-delete:' + alert.id)
      ],
      [
        Markup.button.callback(alert.enabled ? 'غیرفعال کردن' : 'فعال کردن', 'alert-toggle:' + alert.id)
      ]
    ]));
  }
}

async function startNewAlert(ctx) {
  setStep(ctx.chat.id, { step: 'transport' });
  await ctx.reply('نوع سفر را انتخاب کن:', transportKeyboard());
}

async function startEditAlert(ctx, alert) {
  setStep(ctx.chat.id, { step: 'transport', editingId: alert.id });
  await ctx.reply('برای ویرایش، اطلاعات درخواست را دوباره انتخاب کن. نوع سفر را انتخاب کن:', transportKeyboard());
}

function createBot() {
  if (!BOT_TOKEN) {
    logger.warn('BOT_TOKEN is missing; Telegram bot will not launch.');
    return null;
  }

  const bot = new Telegraf(BOT_TOKEN);
  installAutoDelete(bot);

  bot.start((ctx) => ctx.reply([
    'بات هشدار قیمت بلیط آماده است.',
    '',
    'از دکمه‌های پایین استفاده کن.'
  ].join('\n'), mainMenu));

  bot.hears('هشدار جدید', startNewAlert);
  bot.command('newalert', startNewAlert);

  bot.hears('هشدارهای من', sendAlertsList);
  bot.command('alerts', sendAlertsList);

  bot.action('menu:new', async (ctx) => {
    await ctx.answerCbQuery();
    await startNewAlert(ctx);
  });

  bot.action('menu:alerts', async (ctx) => {
    await ctx.answerCbQuery();
    await sendAlertsList(ctx);
  });

  bot.command('stopalert', async (ctx) => {
    const id = ctx.message.text.split(/\s+/)[1];
    if (!id) return ctx.reply('شناسه هشدار را بعد از دستور بفرست. مثال: /stopalert abc123', mainMenu);
    const alert = updateAlert(id, { enabled: false });
    await ctx.reply(alert ? 'هشدار غیرفعال شد.' : 'هشداری با این شناسه پیدا نشد.', mainMenu);
  });

  bot.action(/alert-edit:([a-f0-9]+)/, async (ctx) => {
    const alert = loadAlerts()[ctx.match[1]];
    if (!alert || String(alert.chatId) !== String(ctx.chat.id)) {
      await ctx.answerCbQuery();
      return ctx.reply('این درخواست پیدا نشد.', mainMenu);
    }
    await startEditAlert(ctx, alert);
    await ctx.answerCbQuery();
  });

  bot.action(/alert-delete:([a-f0-9]+)/, async (ctx) => {
    const alert = loadAlerts()[ctx.match[1]];
    if (!alert || String(alert.chatId) !== String(ctx.chat.id)) {
      await ctx.answerCbQuery();
      return ctx.reply('این درخواست پیدا نشد.', mainMenu);
    }
    deleteAlert(alert.id);
    await ctx.reply('درخواست حذف شد.', mainMenu);
    await ctx.answerCbQuery();
  });

  bot.action(/alert-toggle:([a-f0-9]+)/, async (ctx) => {
    const alert = loadAlerts()[ctx.match[1]];
    if (!alert || String(alert.chatId) !== String(ctx.chat.id)) {
      await ctx.answerCbQuery();
      return ctx.reply('این درخواست پیدا نشد.', mainMenu);
    }
    const updated = updateAlert(alert.id, { enabled: !alert.enabled, updatedAt: new Date().toISOString() });
    await ctx.reply(updated.enabled ? 'درخواست فعال شد.' : 'درخواست غیرفعال شد.', mainMenu);
    await ctx.answerCbQuery();
  });

  bot.action(/transport:(\w+)/, async (ctx) => {
    const transport = ctx.match[1];
    if (!hasActiveProvider(transport)) {
      await ctx.reply('فعلاً برای ' + (transports[transport] || transport) + ' منبع قیمت فعال نداریم. الان فقط هواپیما فعال است.', mainMenu);
      await ctx.answerCbQuery();
      return;
    }
    setStep(ctx.chat.id, { step: 'origin', transport });
    await ctx.reply('مبدا را انتخاب کن:', keyboardFromMap(origins, 'origin'));
    await ctx.answerCbQuery();
  });

  bot.action(/origin:(\w+)/, async (ctx) => {
    const code = ctx.match[1];
    setStep(ctx.chat.id, { step: 'destination', origin: code, originName: cityNameByCode(origins, code) });
    await ctx.reply('مقصد را انتخاب کن:', keyboardFromMap(destinations, 'destination'));
    await ctx.answerCbQuery();
  });

  bot.action(/destination:(\w+)/, async (ctx) => {
    const code = ctx.match[1];
    setStep(ctx.chat.id, { step: 'date-year', dateStep: 'start', destination: code, destinationName: cityNameByCode(destinations, code) });
    await ctx.reply('سال شروع بازه سفر را انتخاب کن:', yearKeyboard());
    await ctx.answerCbQuery();
  });

  bot.action(/date-year:(\d+)/, async (ctx) => {
    const state = getStep(ctx.chat.id) || {};
    setStep(ctx.chat.id, { step: 'date-month', jy: Number(ctx.match[1]) });
    await ctx.reply('ماه ' + (state.dateStep === 'end' ? 'پایان' : 'شروع') + ' بازه سفر را انتخاب کن:', monthKeyboard());
    await ctx.answerCbQuery();
  });

  bot.action(/date-month:(\d+)/, async (ctx) => {
    const state = getStep(ctx.chat.id);
    if (!state?.jy) return ctx.answerCbQuery();
    const jm = Number(ctx.match[1]);
    setStep(ctx.chat.id, { step: 'date-day', jm });
    await ctx.reply('روز ' + (state.dateStep === 'end' ? 'پایان' : 'شروع') + ' بازه سفر را انتخاب کن:', dayKeyboard(state.jy, jm));
    await ctx.answerCbQuery();
  });

  bot.action(/date-day:(\d+)/, async (ctx) => {
    const state = getStep(ctx.chat.id);
    if (!state?.jy || !state?.jm) return ctx.answerCbQuery();
    const jd = Number(ctx.match[1]);
    const date = toGregorianDateString(state.jy, state.jm, jd);
    const jalaliDate = state.jy + '/' + String(state.jm).padStart(2, '0') + '/' + String(jd).padStart(2, '0');
    if (state.dateStep === 'end') {
      if (state.date && date < state.date) {
        await ctx.reply('تاریخ پایان نمی‌تواند قبل از تاریخ شروع باشد. سال پایان را دوباره انتخاب کن:', yearKeyboard());
        await ctx.answerCbQuery();
        return;
      }
      setStep(ctx.chat.id, { step: 'passengers', endJd: jd, endDate: date, jalaliEndDate: jalaliDate });
      await ctx.reply('تعداد مسافر را انتخاب کن:', passengerKeyboard());
      await ctx.answerCbQuery();
      return;
    }
    setStep(ctx.chat.id, { step: 'date-year', dateStep: 'end', jd, date, jalaliDate });
    await ctx.reply('سال پایان بازه سفر را انتخاب کن:', yearKeyboard());
    await ctx.answerCbQuery();
  });

  bot.action(/passengers:(\d+)/, async (ctx) => {
    setStep(ctx.chat.id, { step: 'mode', passengers: Number(ctx.match[1]) });
    await ctx.reply('حالت هشدار را انتخاب کن:', modeKeyboard());
    await ctx.answerCbQuery();
  });

  bot.action(/mode:(\w+)/, async (ctx) => {
    const mode = ctx.match[1];
    const state = getStep(ctx.chat.id);
    if (!state) return ctx.answerCbQuery();
    if (mode === 'threshold') {
      setStep(ctx.chat.id, { step: 'thresholdPrice', mode });
      await ctx.reply('مبلغ هدف را انتخاب کن:', thresholdKeyboard());
    } else {
      const alert = persistAlert(ctx.chat.id, state, { mode: 'smart' });
      clearStep(ctx.chat.id);
      await saveAndCheck(ctx, alert);
    }
    await ctx.answerCbQuery();
  });

  bot.action(/threshold:(\w+)/, async (ctx) => {
    const value = ctx.match[1];
    const state = getStep(ctx.chat.id);
    if (!state) return ctx.answerCbQuery();
    if (value === 'custom') {
      setStep(ctx.chat.id, { step: 'thresholdPriceText', mode: 'threshold' });
      await ctx.reply('مبلغ دلخواه را به تومان بفرست. مثال: 2500000');
    } else {
      const alert = persistAlert(ctx.chat.id, state, { mode: 'threshold', thresholdPrice: Number(value) });
      clearStep(ctx.chat.id);
      await saveAndCheck(ctx, alert);
    }
    await ctx.answerCbQuery();
  });

  bot.on('text', async (ctx) => {
    const state = getStep(ctx.chat.id);
    if (!state) return ctx.reply('از دکمه‌های پایین استفاده کن.', mainMenu);
    const text = ctx.message.text.trim();

    if (state.step === 'thresholdPriceText') {
      const thresholdPrice = Number(text.replace(/[,٬\s]/g, ''));
      if (!Number.isFinite(thresholdPrice) || thresholdPrice <= 0) return ctx.reply('مبلغ معتبر نیست.');
      const alert = persistAlert(ctx.chat.id, state, { thresholdPrice });
      clearStep(ctx.chat.id);
      return saveAndCheck(ctx, alert);
    }
  });

  bot.catch((error) => logger.error('Bot error: ' + error.message));
  return bot;
}

function startBot() {
  const bot = createBot();
  if (!bot) return null;
  bot.launch();
  logger.info('Ticket alert bot started.');
  return bot;
}

module.exports = { createBot, startBot, sendManagedMessage };
