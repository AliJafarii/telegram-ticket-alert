const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const logger = require('./logger');

const DATA_DIR = path.join(__dirname, '..', 'data');
const ALERTS_PATH = path.join(DATA_DIR, 'alerts.json');
const HISTORY_PATH = path.join(DATA_DIR, 'price-history.jsonl');
const PROVIDERS_PATH = path.join(__dirname, '..', 'config', 'providers.json');

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    logger.error(`Failed to read ${file}: ${error.message}`);
    return fallback;
  }
}

function writeJson(file, data) {
  ensureDataDir();
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function loadAlerts() {
  return readJson(ALERTS_PATH, {});
}

function saveAlerts(alerts) {
  writeJson(ALERTS_PATH, alerts);
}

function createAlert(chatId, input) {
  const alerts = loadAlerts();
  const id = crypto.randomBytes(5).toString('hex');
  alerts[id] = {
    id,
    chatId: String(chatId),
    enabled: true,
    createdAt: new Date().toISOString(),
    lastNotifiedAt: null,
    lastNotifiedAtByDate: {},
    lastLowestPrice: null,
    endDate: input.endDate || input.date,
    jalaliEndDate: input.jalaliEndDate || input.jalaliDate,
    ...input
  };
  saveAlerts(alerts);
  return alerts[id];
}

function updateAlert(id, patch) {
  const alerts = loadAlerts();
  if (!alerts[id]) return null;
  alerts[id] = { ...alerts[id], ...patch };
  saveAlerts(alerts);
  return alerts[id];
}

function deleteAlert(id) {
  const alerts = loadAlerts();
  if (!alerts[id]) return null;
  const deleted = alerts[id];
  delete alerts[id];
  saveAlerts(alerts);
  return deleted;
}

function appendHistory(row) {
  ensureDataDir();
  fs.appendFileSync(HISTORY_PATH, JSON.stringify({ ...row, checkedAt: new Date().toISOString() }) + '\n');
}

function readHistory(filter, limit = 5000) {
  try {
    if (!fs.existsSync(HISTORY_PATH)) return [];
    const lines = fs.readFileSync(HISTORY_PATH, 'utf8').trim().split('\n').filter(Boolean);
    return lines.slice(-limit)
      .map((line) => JSON.parse(line))
      .filter((row) =>
        row.transport === filter.transport &&
        row.origin === filter.origin &&
        row.destination === filter.destination &&
        row.date === filter.date
      );
  } catch (error) {
    logger.warn(`Failed to read price history: ${error.message}`);
    return [];
  }
}

function loadProviders() {
  return readJson(PROVIDERS_PATH, []);
}

module.exports = {
  loadAlerts,
  saveAlerts,
  createAlert,
  updateAlert,
  deleteAlert,
  appendHistory,
  readHistory,
  loadProviders
};
