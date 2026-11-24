// Replay archived result rows into a NEW private copy. Never open source databases writable.
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync, backup } = require('node:sqlite');
const { discover } = require('./reader.cjs');
async function prepareReplay(sourceFolder, outputFolder, event) {
  const source = fs.realpathSync(sourceFolder), output = path.resolve(outputFolder);
  if (source === output || fs.existsSync(output)) throw Error('Replay requires a new, non-existing output folder.');
  const entry = discover(source).find(e => e.number === event);
  if (!entry) throw Error('Source event not found.');
  fs.mkdirSync(output, { recursive: true });
  const mainName = entry.file, extraName = mainName.replace(/\.scdb$/i, 'Ex.scdb');
  for (const name of [mainName, extraName]) {
    const db = new DatabaseSync(path.join(source, name), { readOnly: true });
    try { await backup(db, path.join(output, name)); } finally { db.close(); }
  }
  const db = new DatabaseSync(path.join(output, extraName));
  const rows = entry.heats.map(heat => ({ heat, rows: db.prepare(`SELECT * FROM TTIMEINFOS_HEAT${heat}`).all() }));
  const order = [];
  const startTable = `TSTARTLIST_HEAT${entry.heats[0]}`;
  if (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(startTable))
    order.push(...db.prepare(`SELECT C_NUM FROM ${startTable} ORDER BY C_LINE`).all().map(r => r.C_NUM));
  order.push(...rows.flatMap(h => h.rows.map(r => r.C_NUM)));
  const queue = [...new Set(order)].filter(bib => rows.some(h => h.rows.some(r => r.C_NUM === bib && (r.C_TIME > 0 || [1, 2, 3].includes(r.C_STATUS)))));
  const plan = { event, mainName, extraName, heats: entry.heats, queue, rows };
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const h of rows) {
      db.exec(`DELETE FROM TTIMEINFOS_HEAT${h.heat}`);
      db.prepare('UPDATE TUPDATEVALUES SET UPDATEVALUE=COALESCE(UPDATEVALUE,0)+1 WHERE TABLENAME=?').run(`TTIMEINFOS_HEAT${h.heat}`);
    }
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  finally { db.close(); }
  fs.writeFileSync(path.join(output, 'replay-plan.json'), JSON.stringify(plan), { mode: 0o600 });
  return plan;
}
class Replay {
  constructor(folder) {
    this.folder = folder; this.plan = JSON.parse(fs.readFileSync(path.join(folder, 'replay-plan.json'), 'utf8')); this.index = 0;
    if (!/^Event\d+Ex\.scdb$/i.test(this.plan.extraName) || !this.plan.heats.every(h => Number.isInteger(h) && h > 0 && h < 10)) throw Error('Invalid replay plan');
    this.db = new DatabaseSync(path.join(folder, this.plan.extraName)); this.db.exec('PRAGMA busy_timeout=1000');
  }
  step() {
    if (this.index >= this.plan.queue.length) return false;
    const bib = this.plan.queue[this.index];
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const h of this.plan.rows) {
        const row = h.rows.find(r => r.C_NUM === bib); if (!row) continue;
        const keys = Object.keys(row); if (keys.some(k => !/^C_[A-Z0-9_]+$/.test(k))) throw Error('Invalid column');
        this.db.prepare(`INSERT OR REPLACE INTO TTIMEINFOS_HEAT${h.heat} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...keys.map(k => row[k]));
        this.db.prepare('UPDATE TUPDATEVALUES SET UPDATEVALUE=COALESCE(UPDATEVALUE,0)+1 WHERE TABLENAME=?').run(`TTIMEINFOS_HEAT${h.heat}`);
      }
      this.db.exec('COMMIT'); this.index++; return true;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  reset() {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const h of this.plan.heats) {
        this.db.exec(`DELETE FROM TTIMEINFOS_HEAT${h}`);
        this.db.prepare('UPDATE TUPDATEVALUES SET UPDATEVALUE=COALESCE(UPDATEVALUE,0)+1 WHERE TABLENAME=?').run(`TTIMEINFOS_HEAT${h}`);
      }
      this.db.exec('COMMIT'); this.index = 0;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  close() { this.db.close(); }
}
module.exports = { prepareReplay, Replay };
