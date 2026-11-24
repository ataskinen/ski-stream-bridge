const fs = require('node:fs');
const path = require('node:path');
const { isSea } = require('node:sea');
const { loadConfig, loadKey } = require('./config.cjs');
const { VolaReader, discover } = require('./reader.cjs');
const { Logger, errorDetails } = require('./log.cjs');
const { Bridge } = require('./server.cjs');
async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log('Ski Stream Bridge\n  --config FILE        Settings JSON (default: config.json)\n  --list               List competitions, then exit\n  --debug              Enable detailed diagnostic logs\n  --export-logs FILE   Export logs to a .json.gz file, then exit'); return;
  }
  for (let i = 0; i < args.length; i++) {
    if (['--config', '--export-logs'].includes(args[i])) { if (!args[++i] || args[i].startsWith('--')) throw new Error('Missing argument value.'); }
    else if (!['--list', '--debug'].includes(args[i])) throw new Error('Unknown argument. Use --help.');
  }
  const value = flag => args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;
  const file = value('--config') || path.join(isSea() ? path.dirname(process.execPath) : process.cwd(), 'config.json');
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, JSON.stringify({ folder: path.dirname(path.resolve(file)), event: 1, autoStandings: true }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  }
  const config = loadConfig(file);
  const log = new Logger(config.logDirectory, config.debug || args.includes('--debug'));
  if (value('--export-logs')) { log.export(path.resolve(value('--export-logs'))); console.log('Diagnostics exported. No connection keys or competitor records included.'); return; }
  if (args.includes('--list')) { console.table(discover(config.folder)); return; }
  let reader;
  try { reader = new VolaReader(config); }
  catch (error) {
    log.write('startup-failed', errorDetails(error));
    // Keep local setup reachable even before a valid VOLA folder/event has been chosen.
    let delegate;
    reader = { tablesRead: 0, read() { delegate ||= new VolaReader(config); const state = delegate.read(); this.tablesRead = delegate.tablesRead; return state; }, close() { delegate?.close(); } };
  }
  const saveSelection = selection => {
    const original = JSON.parse(fs.readFileSync(file, 'utf8'));
    const temporary = file + '.tmp';
    fs.writeFileSync(temporary, JSON.stringify({ ...original, ...selection }, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(temporary, file);
  };
  const bridge = new Bridge(reader, loadKey(config.keyFile), config, log, saveSelection);
  try { await bridge.start(); } catch (error) { log.write('startup-failed', errorDetails(error)); reader.close(); throw error; }
  console.log(`Ski Stream Bridge listening on ${config.bind}:${config.port}\nControl: http://127.0.0.1:${config.port}/\nTiming mode: ${config.timing.mode}. Connection key: ${config.keyFile}\nDebug logging: ${log.debug ? 'ON' : 'OFF'}\nLogs: ${config.logDirectory}\nPress Ctrl+C to stop.`);
  let closing = false;
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { if (closing) return; closing = true; await bridge.close(); });
}
main().catch(error => { console.error('Bridge could not start:', error.message); process.exitCode = 1; });
