const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');
// Simulation uses real-shaped VOLA START records, but its status mapping is explicitly synthetic.
class LiveReplay {
  constructor(folder, heat = 1, now = () => Date.now()) {
    this.folder = folder; this.plan = JSON.parse(fs.readFileSync(path.join(folder, 'replay-plan.json'), 'utf8'));
    if (!this.plan.heats.includes(heat)) throw Error('Unavailable heat');
    this.initialHeat = heat; this.heat = heat; this.now = now; this.rows = this.plan.rows.find(h => h.heat === heat).rows;
    this.queue = this.plan.queue; this.index = 0; this.active = new Map(); this.lastStart = 0;
    this.db = new DatabaseSync(path.join(folder, this.plan.extraName)); this.db.exec('PRAGMA busy_timeout=1000');
    this.setHeat(heat);
  }
  setHeat(heat) {
    if (!this.plan.heats.includes(heat) || this.active.size) throw Error("Cannot change heat");
    this.heat = heat; this.rows = this.plan.rows.find(h => h.heat === heat).rows;
    const start = `TSTARTLIST_HEAT${heat}`;
    const order = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(start)
      ? this.db.prepare(`SELECT C_NUM FROM ${start} ORDER BY C_LINE`).all().map(r => r.C_NUM) : this.plan.queue;
    this.queue = [...new Set([...order, ...this.rows.map(r => r.C_NUM)])].filter(b => this.rows.some(r => r.C_NUM === b && (r.C_TIME > 0 || [1, 2, 3].includes(r.C_STATUS))));
    this.index = 0; this.lastStart = 0;
    const table = `TTIMERECORDS_HEAT${heat}_START`;
    if (!this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table)) {
      this.db.exec(`CREATE TABLE ${table}(C_LINE INTEGER PRIMARY KEY,C_NUM INTEGER,C_STATUS INTEGER,C_HOUR1 TEXT,C_HOUR2 TEXT)`);
    }
  }
  get complete() { return this.index >= this.queue.length && this.active.size === 0; }
  get nextHeat() { return this.plan.heats.find(h => h > this.heat); }
  bump(table) {
    this.db.prepare('UPDATE TUPDATEVALUES SET UPDATEVALUE=COALESCE(UPDATEVALUE,0)+1 WHERE TABLENAME=?').run(table);
  }
  reset() {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const heat of this.plan.heats) {
        this.db.exec(`DELETE FROM TTIMEINFOS_HEAT${heat}`); this.bump(`TTIMEINFOS_HEAT${heat}`);
        for (const kind of ['START','FINISH']) {
          const table=`TTIMERECORDS_HEAT${heat}_${kind}`;
          if (this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table)) { this.db.exec(`DELETE FROM ${table}`);this.bump(table); }
        }
      }
      this.db.exec('COMMIT'); this.index = 0; this.active.clear(); this.lastStart = 0; this.setHeat(this.initialHeat);
    } catch(e) { this.db.exec('ROLLBACK'); throw e; }
  }
  startNext() {
    if (this.index >= this.queue.length) return false;
    const bib = this.queue[this.index++], row = this.rows.find(r => r.C_NUM === bib);
    if (!row) return true;
    if (row.C_STATUS === 1) { this.finish(bib, row); return true; }
    const now = this.now(), d = new Date(now);
    const micros = ((d.getHours()*3600+d.getMinutes()*60+d.getSeconds())*1000+d.getMilliseconds())*1000;
    const table=`TTIMERECORDS_HEAT${this.heat}_START`;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const line = this.db.prepare(`SELECT COALESCE(MAX(C_LINE),0)+1 n FROM ${table}`).get().n;
      this.db.prepare(`INSERT INTO ${table}(C_LINE,C_NUM,C_STATUS,C_HOUR1,C_HOUR2) VALUES(?,?,?,?,?)`).run(line,bib,0,String(micros),String(micros));
      this.bump(table);this.db.exec('COMMIT');
      this.active.set(bib,{row,started:now,finishAt:now+(row.C_STATUS===0&&row.C_TIME>0?row.C_TIME:15000)}); this.lastStart=now;
    }catch(e){this.db.exec('ROLLBACK');throw e;}
    return true;
  }
  finish(bib, row) {
    const table=`TTIMEINFOS_HEAT${this.heat}`,keys=Object.keys(row);
    if(keys.some(k=>!/^C_[A-Z0-9_]+$/.test(k)))throw Error('Invalid column');
    this.db.exec('BEGIN IMMEDIATE');
    try { this.db.prepare(`INSERT OR REPLACE INTO ${table} (${keys.join(',')}) VALUES (${keys.map(()=>'?').join(',')})`).run(...keys.map(k=>row[k]));this.bump(table);this.db.exec('COMMIT');this.active.delete(bib); }
    catch(e){this.db.exec('ROLLBACK');throw e;}
  }
  tick({startIntervalMs=5000,maxActive=3,allowStart=true}={}) {
    const now=this.now();
    for(const [bib,r] of this.active)if(now>=r.finishAt)this.finish(bib,r.row);
    if(allowStart&&this.active.size<maxActive&&now-this.lastStart>=startIntervalMs)this.startNext();
  }
  close(){this.db.close();}
}
module.exports={LiveReplay};
