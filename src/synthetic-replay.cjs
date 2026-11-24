// Entirely synthetic VOLA-shaped databases. Never accepts or copies a source database.
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { START_STATUS_DEFAULTS } = require('./timing.cjs');
function prepareSyntheticReplay(folder, { runTimeMs = 15000 } = {}) {
  const root = path.resolve(__dirname, '../local'), output = path.resolve(folder);
  if (path.dirname(output) !== root || !Number.isInteger(runTimeMs) || runTimeMs < 500 || runTimeMs > 60000) throw Error('Use a new direct child of local/ and run time 500–60000 ms.');
  fs.mkdirSync(root, { recursive: true });
  if (fs.lstatSync(root).isSymbolicLink()) throw Error('Synthetic output must not use a symlink.');
  fs.mkdirSync(output, { mode: 0o700 }); // Exclusive creation: an existing target is never reset or overwritten.
  let main, extra;
  try {
    const mainName = 'Event001.scdb', extraName = 'Event001Ex.scdb', queue = [13, 14, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 15];
    main = new DatabaseSync(path.join(output, mainName));
    main.exec(`CREATE TABLE TPARAMETERS(C_PARAM TEXT PRIMARY KEY,C_VALUE TEXT);
      INSERT INTO TPARAMETERS VALUES('TITLE1','Synthetic Two-Run Cup'),('SOFTWARE_VERSION','14.1.08 synthetic');
      CREATE TABLE TUPDATEVALUES(TABLENAME TEXT PRIMARY KEY,UPDATEVALUE INTEGER);
      INSERT INTO TUPDATEVALUES VALUES('TPARAMETERS',1),('TCOMPETITORS',1);
      CREATE TABLE TCOMPETITORS(C_IDX INTEGER PRIMARY KEY,C_NUM INTEGER,C_FIRST_NAME TEXT,C_LAST_NAME TEXT,C_YEAR INTEGER,C_CATEGORY TEXT,C_CLUB TEXT,C_RGPD_DONOTPUBLISH INTEGER);`);
    const insert = main.prepare('INSERT INTO TCOMPETITORS VALUES(?,?,?,?,?,?,?,0)');
    for (let bib = 1; bib <= 15; bib++) insert.run(bib, bib, 'Demo', `Racer ${bib}`, 2000, 'Demo Open', 'Synthetic Club');
    extra = new DatabaseSync(path.join(output, extraName));
    extra.exec('CREATE TABLE TUPDATEVALUES(TABLENAME TEXT PRIMARY KEY,UPDATEVALUE INTEGER)');
    for (const heat of [1, 2]) {
      extra.exec(`CREATE TABLE TTIMEINFOS_HEAT${heat}(C_NUM INTEGER PRIMARY KEY,C_STATUS INTEGER,C_TIME INTEGER,C_PENALTY INTEGER);
        CREATE TABLE TSTARTLIST_HEAT${heat}(C_LINE INTEGER PRIMARY KEY,C_NUM INTEGER);
        CREATE TABLE TTIMERECORDS_HEAT${heat}_FINISH(C_LINE INTEGER PRIMARY KEY,C_NUM INTEGER,C_STATUS INTEGER,C_HOUR2 TEXT);`);
      extra.prepare('INSERT INTO TUPDATEVALUES VALUES(?,1)').run(`TTIMEINFOS_HEAT${heat}`);
      extra.prepare('INSERT INTO TUPDATEVALUES VALUES(?,1)').run(`TTIMERECORDS_HEAT${heat}_START`);
      const start = extra.prepare(`INSERT INTO TSTARTLIST_HEAT${heat} VALUES(?,?)`);
      queue.forEach((bib, index) => start.run(index + 1, bib));
    }
    const rows = [1, 2].map(heat => ({ heat, rows: queue.map(bib => {
      const status = heat === 1 ? ({ 13: 2, 14: 3, 15: 1 }[bib] || 0) : 0;
      return { C_NUM: bib, C_STATUS: status, C_TIME: status ? 0 : runTimeMs + bib * 10 + heat * 100, C_PENALTY: 0 };
    }) }));
    const plan = { kind: 'synthetic-vola-demo', event: 1, mainName, extraName, heats: [1, 2], queue, rows, startStatus: START_STATUS_DEFAULTS.records[0], terminalRecordStatuses: { 1: 131328, 2: 131584, 3: 131840 }, nonFinishMs: runTimeMs, startIntervalMs: Math.max(100, Math.floor(runTimeMs / 3)), breakMs: Math.min(10000, runTimeMs) };
    fs.writeFileSync(path.join(output, 'replay-plan.json'), JSON.stringify(plan), { mode: 0o600 });
    fs.writeFileSync(path.join(output, 'config.json'), JSON.stringify({ folder: '.', event: 1, heats: [1], autoStandings: true, bind: '127.0.0.1', port: 8789, pollIntervalMs: 100, reconcileIntervalMs: 1000, keyFile: 'connection-key', logDirectory: 'logs', debug: true }, null, 2), { mode: 0o600 });
    return plan;
  } catch (error) {
    main?.close(); extra?.close(); main = extra = null;
    fs.rmSync(output, { recursive: true, force: true });
    throw error;
  } finally { main?.close(); extra?.close(); }
}
module.exports = { prepareSyntheticReplay };
