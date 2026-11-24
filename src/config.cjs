const { timingConfig } = require('./timing.cjs');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
function normalizeConfig(value, file) {
  const c = { autoStandings: true, heats: [1], bind: '127.0.0.1', port: 8789, pollIntervalMs: 250, reconcileIntervalMs: 5000, keyFile: 'local/connection-key', debug: false, logDirectory: 'local/logs', ...value };
  for (const [key, min, max] of [['event', 1, 999999], ['port', 1, 65535], ['pollIntervalMs', 100, 60000], ['reconcileIntervalMs', 1000, 60000]])
    if (!Number.isInteger(c[key]) || c[key] < min || c[key] > max) throw new Error(`Invalid ${key}.`);
  if (!Array.isArray(c.heats) || !c.heats.length || c.heats.some(h => !Number.isInteger(h) || h < 1 || h > 9)) throw new Error('heats must contain heat numbers 1–9.');
  if (typeof c.autoStandings !== 'boolean') throw Error('Invalid autoStandings.');
  c.heats = [...new Set(c.heats)].sort();
  if (typeof c.debug !== 'boolean' || typeof c.bind !== 'string' || !c.bind || c.bind.length > 253 || /[\s/]/.test(c.bind)) throw new Error('Invalid debug or bind setting.');
  for (const key of ['folder', 'keyFile', 'logDirectory']) {
    if (typeof c[key] !== 'string' || !c[key].trim()) throw new Error(`Missing ${key}.`);
    c[key] = path.resolve(path.dirname(path.resolve(file)), c[key]);
  }
  c.timing = timingConfig(c.timing, c.heats);
  return c;
}
function loadConfig(file) { return normalizeConfig(JSON.parse(fs.readFileSync(file, 'utf8')), file); }
function loadKey(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try { fs.writeFileSync(file, crypto.randomBytes(32).toString('base64url'), { mode: 0o600, flag: 'wx' }); }
  catch (e) { if (e.code !== 'EEXIST') throw e; }
  const key = fs.readFileSync(file, 'utf8').trim();
  if (!/^[A-Za-z0-9_-]{24,512}$/.test(key)) throw new Error('Invalid connection key file.');
  return key;
}
module.exports = { loadConfig, loadKey, normalizeConfig };
