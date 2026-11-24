const path = require('node:path');
const fs = require('node:fs');
const readline = require('node:readline');
const { loadConfig } = require('../src/config.cjs');
const { prepareReplay, Replay } = require('../src/replay.cjs');
async function main() {
  const args = process.argv.slice(2), option = name => args[args.indexOf(name) + 1];
  if (!args.includes('--folder')) throw Error('Use --folder NEW_REPLAY_FOLDER --source-config config.json --event 3 [--interval-ms 3000] [--prepare-only]');
  const folder = path.resolve(option('--folder'));
  if (args.includes('--source-config')) {
    const config = loadConfig(option('--source-config'));
    const event = args.includes('--event') ? Number(option('--event')) : config.event;
    const plan = await prepareReplay(config.folder, folder, event);
    fs.writeFileSync(path.join(folder, 'config.json'), JSON.stringify({ ...config, folder, event, heats: plan.heats, debug: true }, null, 2), { mode: 0o600 });
    console.log(`Created private replay copy: ${folder}. ${plan.queue.length} competitors queued.`);
  }
  if (args.includes('--prepare-only')) return;
  const interval = args.includes('--interval-ms') ? Number(option('--interval-ms')) : 3000;
  if (!Number.isInteger(interval) || interval < 250 || interval > 60000) throw Error('Interval must be 250–60000 ms');
  const replay = new Replay(folder); let paused = args.includes('--paused');
  const rl = readline.createInterface({ input: process.stdin });
  console.log('Commands: pause, resume, next, reset, quit. Each step restores all selected archived heat rows for ONE competitor; this is a result replay, not live start simulation.');
  const step = () => { if (replay.step()) console.log(`Results ${replay.index}/${replay.plan.queue.length}`); else { paused = true; console.log('Replay complete; final results remain available.'); } };
  const timer = setInterval(() => { if (!paused) { try { step(); } catch { paused = true; console.error('Replay write failed; paused.'); } } }, interval);
  const close = () => { clearInterval(timer); rl.close(); replay.close(); };
  rl.on('line', line => {
    try {
      if (line.trim() === 'pause') { paused = true; console.log('Paused'); }
      else if (line.trim() === 'resume') { paused = false; console.log('Running'); }
      else if (line.trim() === 'next') step();
      else if (line.trim() === 'reset') { paused = true; replay.reset(); console.log('Empty standings restored; resume when ready.'); }
      else if (line.trim() === 'quit') { close(); process.exit(0); }
    } catch { paused = true; console.error('Replay command failed; paused.'); }
  });
  for (const signal of ['SIGINT','SIGTERM']) process.on(signal, () => { close(); process.exit(0); });
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
