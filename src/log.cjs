const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
// An allowlist prevents accidental payloads, file paths and credentials entering logs.
const allowed = new Set(['revision','clients','competitors','results','tablesRead','durationMs','bytes','upserts','deletes','ok','port','eventNumber','heatCount','nodeVersion','platform','arch','reason','sqliteCode']);
const events = new Set(['started','stopped','read','read-failed','recovered','snapshot','delta','connected','disconnected','resync','auth-rejected','slow-client','log-exported','startup-failed']);
class Logger {
  constructor(directory, debug = false, maxBytes = 2 * 1024 * 1024) {
    this.directory = directory; this.debug = debug; this.maxBytes = maxBytes;
    fs.mkdirSync(directory, { recursive: true }); this.file = path.join(directory, 'bridge.log'); this.failed = false;
  }
  write(event, fields = {}, detailed = false) {
    if (detailed && !this.debug) return;
    if (!events.has(event)) throw new Error('Unknown log event');
    const safe = Object.fromEntries(Object.entries(fields).filter(([key, value]) => allowed.has(key) && (typeof value === 'number' || typeof value === 'boolean' || (['nodeVersion','platform','arch','reason','sqliteCode'].includes(key) && /^[\w.\-]+$/.test(value)))));
    const line = JSON.stringify({ timestamp: new Date().toISOString(), level: detailed ? 'debug' : 'info', event, ...safe }) + '\n';
    try {
      if (fs.existsSync(this.file) && fs.statSync(this.file).size + Buffer.byteLength(line) > this.maxBytes) {
        fs.rmSync(this.file + '.3', { force: true });
        for (let n = 2; n >= 1; n--) if (fs.existsSync(this.file + '.' + n)) fs.renameSync(this.file + '.' + n, this.file + '.' + (n + 1));
        fs.renameSync(this.file, this.file + '.1');
      }
      fs.appendFileSync(this.file, line, { mode: 0o600 });
    } catch { if (!this.failed) console.error('Diagnostic log could not be written. Bridge processing continues.'); this.failed = true; }
  }
  export(file) {
    const logs = [3, 2, 1, 0].map(n => path.join(this.directory, 'bridge.log' + (n ? '.' + n : ''))).filter(f => fs.existsSync(f)).map(f => fs.readFileSync(f, 'utf8')).join('');
    const report = { format: 'ski-stream-bridge-diagnostics-v1', exportedAt: new Date().toISOString(), node: process.version, platform: process.platform, arch: process.arch, logs: logs.split('\n').filter(Boolean).map(line => JSON.parse(line)) };
    fs.writeFileSync(file, zlib.gzipSync(JSON.stringify(report, null, 2)), { mode: 0o600 });
    this.write('log-exported');
  }
}
function errorDetails(error) {
  const message = String(error?.message || '');
  let reason = 'unsupported-or-read-error';
  if (/no such table/i.test(message)) reason = 'missing-table';
  else if (/no such column/i.test(message)) reason = 'missing-column';
  else if (/locked|busy/i.test(message)) reason = 'database-busy';
  else if (/malformed|not a database/i.test(message)) reason = 'invalid-database';
  else if (/Duplicate competitor bibs/i.test(message)) reason = 'duplicate-bibs';
  else if (/existing, unambiguous/i.test(message)) reason = 'event-not-found';
  else if (error?.code === 'ENOENT') reason = 'file-not-found';
  else if (['EACCES','EPERM'].includes(error?.code)) reason = 'access-denied';
  else if (error?.code === 'EADDRINUSE') reason = 'port-in-use';
  return { reason, ...(Number.isInteger(error?.errcode) ? { sqliteCode: error.errcode } : {}) };
}
module.exports = { Logger, errorDetails };
