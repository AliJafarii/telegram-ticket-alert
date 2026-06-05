const cron = require('node-cron');
const { Telegraf } = require('telegraf');
const logger = require('./logger');
const { fetchTickets, PROVIDER_NAMES_FA } = require('./api');
const {
  appendHistory,
  loadAlerts,
  loadProviders,
  readHistory,
  updateAlert
} = require('./configManager');
const jalaali = require('jalaali-js');

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHECK_INTERVAL_MINUTES = Math.max(1, Number(process.env.CHECK_INTERVAL_MINUTES || 10));
const SMART_DROP_PERCENT = Math.max(1, Number(process.env.SMART_DROP_PERCENT || 20));
const SMART_MIN_HISTORY = Math.max(2, Number(process.env.SMART_MIN_HISTORY || 6));
const NOTIFY_COOLDOWN_MINUTES = Math.max(5, Number(process.env.NOTIFY_COOLDOWN_MINUTES || 180));
const MAX_ALERT_RANGE_DAYS = Math.max(1, Number(process.env.MAX_ALERT_RANGE_DAYS || 31));
const DELETE_MESSAGES_AFTER_SECONDS = Math.max(0, Number(process.env.DELETE_MESSAGES_AFTER_SECONDS || 300));
const transportLabels = {
  flight: 'هواپیما',
  train: 'قطار',
  bus: 'اتوبوس'
};

function average(values) {
  const clean = values.filter((value) => Number.isFinite(value) && value > 0);
  if (!clean.length) return null;
  return clean.reduce((sum, value) => sum + value, 0) / clean.length;
}

function formatPrice(value) {
  return Math.round(value).toLocaleString('fa-IR') + ' تومان';
}

function toJalali(dateStr) {
  const parts = dateStr.split('-').map(Number);
  const gy = parts[0], gm = parts[1], gd = parts[2];
  try {
    const j = jalaali.toJalaali(gy, gm, gd);
    return j.jy + '/' + String(j.jm).padStart(2, '0') + '/' + String(j.jd).padStart(2, '0');
  } catch (e) {
    return dateStr;
  }
}

function formatTime(timeStr) {
  if (!timeStr) return null;
  // If it looks like a date only (YYYY-MM-DD), don't show it as time
  if (/^\d{4}-\d{2}-\d{2}$/.test(timeStr)) return null;
  // If it looks like a datetime (YYYY-MM-DDTHH:MM or YYYY-MM-DD HH:MM), extract time only
  const dateTimeMatch = timeStr.match(/(\d{1,2}):(\d{2})/);
  if (dateTimeMatch) return dateTimeMatch[1].padStart(2, '0') + ':' + dateTimeMatch[2];
  // If it's just a time string like "14:30", return it
  if (/^\d{1,2}:\d{2}$/.test(timeStr)) return timeStr;
  return null;
}

function routeLabel(alert) {
  return `${alert.originName || alert.origin} ← ${alert.destinationName || alert.destination}`;
}

function addDays(date, days) {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function daysBetween(startDate, endDate) {
  const start = new Date(startDate + 'T00:00:00Z');
  const end = new Date(endDate + 'T00:00:00Z');
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end < start) return [];
  const diff = Math.floor((end - start) / (24 * 60 * 60 * 1000)) + 1;
  const count = Math.min(diff, MAX_ALERT_RANGE_DAYS);
  return Array.from({ length: count }, (_, index) => {
    const date = addDays(startDate, index);
    return { date, jalaliDate: toJalali(date) };
  });
}

async function sendManagedMessage(bot, chatId, text, extra) {
  const sent = await bot.telegram.sendMessage(chatId, text, extra);
  if (DELETE_MESSAGES_AFTER_SECONDS && sent?.message_id) {
    setTimeout(() => {
      bot.telegram.deleteMessage(chatId, sent.message_id).catch((error) => {
        logger.warn('Could not delete message ' + sent.message_id + ' in chat ' + chatId + ': ' + error.message);
      });
    }, DELETE_MESSAGES_AFTER_SECONDS * 1000);
  }
  return sent;
}

async function fetchWeeklyTrend(alert, providers, firstDayLowest) {
  const days = [{
    date: alert.date,
    min: firstDayLowest,
    count: firstDayLowest ? 1 : 0
  }];

  for (let i = 1; i < 7; i += 1) {
    const date = addDays(alert.date, i);
    try {
      const result = await fetchTickets({
        transport: alert.transport,
        origin: alert.origin,
        destination: alert.destination,
        date,
        passengers: alert.passengers || 1
      }, providers);
      const prices = result.tickets.map((ticket) => ticket.price).filter(Boolean);
      days.push({
        date,
        min: prices.length ? Math.min(...prices) : null,
        count: result.tickets.length
      });
    } catch (error) {
      logger.warn(`Weekly trend failed for ${alert.id} on ${date}: ${error.message}`);
      days.push({ date, min: null, count: 0, error: error.message });
    }
  }

  const minima = days.map((day) => day.min).filter((value) => Number.isFinite(value) && value > 0);
  const avgDailyMin = average(minima);
  const currentDropPercent = avgDailyMin && firstDayLowest
    ? ((avgDailyMin - firstDayLowest) / avgDailyMin) * 100
    : null;

  return { days, avgDailyMin, currentDropPercent };
}

function shouldNotify(alert, lowestPrice, historyRows, weeklyTrend) {
  if (!lowestPrice) return { ok: false, reason: 'no price' };

  const lastNotifiedAt = alert.lastNotifiedAt ? new Date(alert.lastNotifiedAt).getTime() : 0;
  if (lastNotifiedAt && Date.now() - lastNotifiedAt < NOTIFY_COOLDOWN_MINUTES * 60 * 1000) {
    return { ok: false, reason: 'cooldown' };
  }

  if (alert.mode === 'threshold') {
    return {
      ok: lowestPrice <= Number(alert.thresholdPrice || 0),
      reason: `threshold ${alert.thresholdPrice}`
    };
  }

  if (weeklyTrend?.avgDailyMin && weeklyTrend.currentDropPercent >= SMART_DROP_PERCENT) {
    return {
      ok: true,
      reason: `weekly trend drop ${weeklyTrend.currentDropPercent.toFixed(1)}%`,
      avg: weeklyTrend.avgDailyMin,
      dropPercent: weeklyTrend.currentDropPercent,
      weeklyTrend
    };
  }

  if (historyRows.length < SMART_MIN_HISTORY) {
    return {
      ok: false,
      reason: 'not enough history ' + historyRows.length + '/' + SMART_MIN_HISTORY,
      weeklyTrend
    };
  }

  const avg = average(historyRows.map((row) => row.lowestPrice));
  if (!avg) return { ok: false, reason: 'not enough history' };
  const dropPercent = ((avg - lowestPrice) / avg) * 100;
  return {
    ok: dropPercent >= SMART_DROP_PERCENT,
    reason: `smart drop ${dropPercent.toFixed(1)}%`,
    avg,
    dropPercent
  };
}

function buildPurchaseLink(ticket, alert) {
  const date = alert.date;
  const passengers = alert.passengers || 1;
  const origin = alert.origin;
  const dest = alert.destination;

  switch (ticket.provider) {
    case 'mrbilit-flight':
      return 'https://www.mrbilit.com/flight/search?origin=' + origin + '&destination=' + dest + '&date=' + date + '&adult=' + passengers;
    case 'flytoday-flight':
      return 'https://www.flytoday.ir/flight/search?departure=' + origin.toLowerCase() + '%2C1&arrival=' + dest.toLowerCase() + '%2C1&departureDate=' + date + '&adt=' + passengers + '&chd=0&inf=0&cabin=1&isDomestic=true&isAnyWhere=false&lang=fa&route=search#drawer';
    case 'safarmarket-flight-calendar':
      return 'https://safarmarket.com/flights/c' + origin + '-c' + dest + '/' + date + '/0/economy/' + passengers + 'adults/0children/0infants';
    case 'alibaba-flight':
      return 'https://www.alibaba.ir/flight/' + origin + '-' + dest + '/' + date + '?adult=' + passengers;
    case 'trip-flight':
      return 'https://www.trip.ir/flight/' + origin + '-' + dest + '/' + date + '?passengers=' + passengers;
    case 'eligasht-flight':
      return 'https://www.eligasht.com/flight/search?origin=' + origin + '&destination=' + dest + '&date=' + date + '&passengers=' + passengers;
    case 'snapptrip-flight':
      return 'https://www.snapptrip.com/flights/' + origin + '-' + dest + '/' + date + '?adult=' + passengers;
    default:
      return ticket.deepLink || null;
  }
}

function buildTicketPage(ticket, alert, pageNum, totalPages) {
  const lines = [];
  const providerFa = ticket.providerFa || PROVIDER_NAMES_FA[ticket.provider] || ticket.provider;
  const jalaliDate = toJalali(alert.date);
  const timeStr = formatTime(ticket.departureTime);

  lines.push(`✈️ ${providerFa}`);
  lines.push(`💰 ${formatPrice(ticket.price)}`);

  if (ticket.airlineName) lines.push(`🛫 ${ticket.airlineName}`);
  if (ticket.flightNumber) lines.push(`🔢 پرواز: ${ticket.flightNumber}`);

  // Date and time on one line, Jalali only
  if (timeStr) {
    lines.push(`📅 ${jalaliDate} | 🕐 ${timeStr}`);
  } else {
    lines.push(`📅 ${jalaliDate}`);
  }

  if (ticket.seats !== null && ticket.seats !== undefined) lines.push(`💺 صندلی باقی‌مانده: ${ticket.seats}`);

  // Direct purchase link for this specific provider only
  const purchaseLink = buildPurchaseLink(ticket, alert);
  if (purchaseLink) {
    lines.push(`🔗 خرید: ${purchaseLink}`);
  }

  if (totalPages > 1) {
    lines.push('', `📄 ${pageNum}/${totalPages}`);
  }

  return lines.join('\n');
}

function buildAlertMessage(alert, tickets, decision, errors) {
  const isThreshold = alert.mode === 'threshold';
  const thresholdPrice = Number(alert.thresholdPrice || 0);

  let ticketsToShow = [tickets[0]];
  if (isThreshold && thresholdPrice > 0) {
    ticketsToShow = tickets.filter(t => t.price <= thresholdPrice);
  }

  const totalPages = ticketsToShow.length;
  const jalaliDate = toJalali(alert.date);
  const route = routeLabel(alert);

  const header = [
    '🎫 پیشنهاد بلیط',
    '',
    `📍 مسیر: ${route}`,
    `📅 تاریخ: ${jalaliDate}`,
    `🚍 نوع سفر: ${transportLabels[alert.transport] || alert.transport}`,
  ];

  if (isThreshold) {
    header.push(`💵 بودجه شما: ${formatPrice(thresholdPrice)}`);
  }

  if (decision.avg) header.push(`📊 میانگین تاریخی: ${formatPrice(decision.avg)}`);
  if (decision.dropPercent) header.push(`📉 افت نسبت به میانگین: ${decision.dropPercent.toFixed(1)}٪`);

  const pages = ticketsToShow.map((ticket, i) => {
    return buildTicketPage(ticket, alert, i + 1, totalPages);
  });

  const footer = [];
  if (errors.length) {
    const failedNames = errors.map(e => PROVIDER_NAMES_FA[e.provider] || e.provider).join('، ');
    footer.push('', '⚠️ منابع در دسترس نبودند: ' + failedNames);
  }

  return {
    header: header.join('\n'),
    pages,
    footer: footer.join('\n'),
    totalPages
  };
}

function buildNoProviderMessage(alert) {
  return [
    'هشدار ثبت شده، ولی فعلاً منبع قیمت فعال نیست.',
    '',
    'مسیر: ' + routeLabel(alert),
    'نوع سفر: ' + (transportLabels[alert.transport] || alert.transport),
    '',
    'برای اینکه alert واقعی بدهیم باید حداقل یک API قیمت برای این نوع سفر فعال باشد.'
  ].join('\n');
}

function buildNoTicketMessage(alert, errors) {
  const lines = [
    'برای این هشدار فعلاً قیمت پیدا نشد.',
    '',
    'مسیر: ' + routeLabel(alert),
    'نوع سفر: ' + (transportLabels[alert.transport] || alert.transport)
  ];
  if (errors.length) {
    const failedNames = errors.map(e => PROVIDER_NAMES_FA[e.provider] || e.provider).join('، ');
    lines.push('', 'منابع در دسترس نبودند: ' + failedNames);
  }
  return lines.join('\n');
}

function buildCurrentPriceMessage(alert, ticket, historyRows, weeklyTrend) {
  const providerFa = ticket.providerFa || PROVIDER_NAMES_FA[ticket.provider] || ticket.provider;
  const jalaliDate = toJalali(alert.date);
  const timeStr = formatTime(ticket.departureTime);
  const weeklyLines = [];
  if (weeklyTrend?.avgDailyMin) {
    weeklyLines.push('میانگین کف قیمت ۷ روز آینده: ' + formatPrice(weeklyTrend.avgDailyMin));
  }
  if (weeklyTrend?.currentDropPercent !== null && weeklyTrend?.currentDropPercent !== undefined) {
    weeklyLines.push('فاصله قیمت فعلی با میانگین هفته: ' + weeklyTrend.currentDropPercent.toFixed(1) + '٪');
  }

  return [
    'قیمت فعلی ذخیره شد.',
    '',
    'مسیر: ' + routeLabel(alert),
    'نوع سفر: ' + (transportLabels[alert.transport] || alert.transport),
    'کمترین قیمت فعلی: ' + formatPrice(ticket.price),
    'منبع: ' + providerFa,
    ticket.airlineName ? 'شرکت هواپیمایی: ' + ticket.airlineName : null,
    ticket.flightNumber ? 'شماره پرواز: ' + ticket.flightNumber : null,
    timeStr ? 'تاریخ و ساعت حرکت: ' + jalaliDate + ' - ' + timeStr : 'تاریخ سفر: ' + jalaliDate,
    ticket.seats !== null && ticket.seats !== undefined ? 'ظرفیت/صندلی: ' + ticket.seats : null,
    ...weeklyLines,
    '',
    'برای حالت هوشمند باید چند نوبت قیمت جمع شود. الان ' + historyRows.length + ' رکورد داریم.'
  ].filter(Boolean).join('\n');
}

function shouldSendServiceMessage(alert, field) {
  const lastAt = alert[field] ? new Date(alert[field]).getTime() : 0;
  return !lastAt || Date.now() - lastAt > 6 * 60 * 60 * 1000;
}

async function sendAlertMessages(bot, alert, tickets, decision, errors) {
  const msg = buildAlertMessage(alert, tickets, decision, errors);

  if (msg.totalPages === 1) {
    const fullMsg = msg.header + '\n\n' + msg.pages[0] + msg.footer;
    await sendManagedMessage(bot, alert.chatId, fullMsg, { disable_web_page_preview: true });
  } else {
    await sendManagedMessage(bot, alert.chatId, msg.header, { disable_web_page_preview: true });
    for (const page of msg.pages) {
      await sendManagedMessage(bot, alert.chatId, page, { disable_web_page_preview: true });
    }
    if (msg.footer) {
      await sendManagedMessage(bot, alert.chatId, msg.footer, { disable_web_page_preview: true });
    }
  }
}

async function checkAlert(bot, alert, providers) {
  const activeProviders = providers.filter((provider) =>
    provider.enabled !== false && (!provider.transports || provider.transports.includes(alert.transport))
  );
  if (!activeProviders.length) {
    logger.warn(`Alert ${alert.id}: no enabled providers for ${alert.transport}`);
    if (shouldSendServiceMessage(alert, 'lastProviderWarningAt')) {
      await sendManagedMessage(bot, alert.chatId, buildNoProviderMessage(alert));
      updateAlert(alert.id, { lastProviderWarningAt: new Date().toISOString() });
    }
    return;
  }

  const params = {
    transport: alert.transport,
    origin: alert.origin,
    destination: alert.destination,
    date: alert.date,
    passengers: alert.passengers || 1
  };
  const { tickets, errors } = await fetchTickets(params, providers);
  if (!tickets.length) {
    logger.info(`Alert ${alert.id}: no tickets found`);
    if (shouldSendServiceMessage(alert, 'lastNoTicketWarningAt')) {
      await sendManagedMessage(bot, alert.chatId, buildNoTicketMessage(alert, errors), {
        disable_web_page_preview: true
      });
      updateAlert(alert.id, { lastNoTicketWarningAt: new Date().toISOString() });
    }
    return;
  }

  const lowest = tickets[0];
  const weeklyTrend = alert.mode === 'smart'
    ? await fetchWeeklyTrend(alert, providers, lowest.price)
    : null;

  appendHistory({
    alertId: alert.id,
    transport: alert.transport,
    origin: alert.origin,
    destination: alert.destination,
    date: alert.date,
    lowestPrice: lowest.price,
    provider: lowest.provider
  });

  const historyRows = readHistory(alert, 2000);
  const decision = shouldNotify(alert, lowest.price, historyRows, weeklyTrend);
  logger.info(`Alert ${alert.id}: lowest=${lowest.price}, notify=${decision.ok}, reason=${decision.reason}`);
  updateAlert(alert.id, { lastLowestPrice: lowest.price });

  if (alert.mode === 'smart' && decision.reason?.startsWith('not enough history') && shouldSendServiceMessage(alert, 'lastBaselineMessageAt')) {
    await sendManagedMessage(bot, alert.chatId, buildCurrentPriceMessage(alert, lowest, historyRows, weeklyTrend), {
      disable_web_page_preview: true
    });
    updateAlert(alert.id, { lastBaselineMessageAt: new Date().toISOString(), lastLowestPrice: lowest.price });
    return;
  }

  if (!decision.ok) return;

  const notifiedAt = new Date().toISOString();
  await sendAlertMessages(bot, alert, tickets, decision, errors);
  const currentAlert = loadAlerts()[alert.id] || alert;
  updateAlert(alert.id, {
    lastNotifiedAt: notifiedAt,
    lastLowestPrice: lowest.price,
    lastNotifiedAtByDate: {
      ...(currentAlert.lastNotifiedAtByDate || {}),
      [alert.date]: notifiedAt
    }
  });
}

async function processAlerts(bot) {
  const alerts = Object.values(loadAlerts()).filter((alert) => alert.enabled);
  const providers = loadProviders();
  for (const alert of alerts) {
    const dates = daysBetween(alert.date, alert.endDate || alert.date);
    if (!dates.length) {
      logger.warn(`Alert ${alert.id}: invalid date range ${alert.date}..${alert.endDate || alert.date}`);
      continue;
    }

    for (const dateInfo of dates) {
      try {
        await checkAlert(bot, {
          ...alert,
          date: dateInfo.date,
          jalaliDate: dateInfo.jalaliDate,
          lastNotifiedAt: alert.lastNotifiedAtByDate?.[dateInfo.date] || alert.lastNotifiedAt
        }, providers);
      } catch (error) {
        logger.error(`Alert ${alert.id} on ${dateInfo.date}: ${error.message}`);
      }
    }
  }
}

function startScheduler(bot) {
  const expr = `*/${CHECK_INTERVAL_MINUTES} * * * *`;
  cron.schedule(expr, () => processAlerts(bot));
  logger.info(`Scheduler started: every ${CHECK_INTERVAL_MINUTES} minute(s).`);
  processAlerts(bot).catch((error) => logger.error(`Initial alert check failed: ${error.message}`));
}

function createBotForScheduler() {
  if (!BOT_TOKEN) return null;
  return new Telegraf(BOT_TOKEN);
}

module.exports = { startScheduler, processAlerts, createBotForScheduler, checkAlert };
