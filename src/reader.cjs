const { addTiming, timingConfig, validResult } = require('./timing.cjs');
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const { isDeepStrictEqual: equal } = require('node:util');
const text = value => String(value ?? '').trim().replace(/[\x00-\x1f\x7f]/g, ' ');
function connect(file) {
  const db = new DatabaseSync(file, { readOnly: true, enableExtensions: false });
  db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=100;');
  return db;
}
function discoverHeats(db) {
  return db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name GLOB 'TTIMEINFOS_HEAT[1-9]'").all().map(r => Number(r.name.split('HEAT')[1])).sort();
}
function discover(folder) {
  return fs.readdirSync(folder).filter(f => /^Event\d+\.scdb$/i.test(f)).sort().map(file => {
    let db, ex;
    try {
      db = connect(path.join(folder, file));
      const params = Object.fromEntries(db.prepare('SELECT C_PARAM,C_VALUE FROM TPARAMETERS').all().map(r => [r.C_PARAM, r.C_VALUE]));
      ex = connect(path.join(folder, file.replace(/\.scdb$/i, 'Ex.scdb')));
      const heats = discoverHeats(ex);
      return { number: Number(file.match(/\d+/)[0]), file, title: text(params.TITLE1), version: text(params.SOFTWARE_VERSION), heats };
    } catch { return null; }
    finally { db?.close(); ex?.close(); }
  }).filter(Boolean);
}
class VolaReader {
  constructor(config) {
    this.config = { autoStandings: true, ...config, timing: timingConfig(config.timing, config.heats) };
    const matches = discover(config.folder).filter(e => e.number === config.event);
    if (matches.length !== 1) throw new Error('Select an existing, unambiguous VOLA event number.');
    this.readHeats = this.config.autoStandings ? matches[0].heats : this.config.heats;
    this.paths = [path.join(config.folder, matches[0].file), path.join(config.folder, matches[0].file.replace(/\.scdb$/i, 'Ex.scdb'))];
    this.dbs = []; this.identity = ''; this.cache = new Map(); this.counters = []; this.versions = []; this.schemaVersion = null; this.lastFull = -Infinity; this.tablesRead = 0;
  }
  close() { for (const db of this.dbs) db.close(); this.dbs = []; }
  open() {
    const identity = JSON.stringify(this.paths.map(p => { const s = fs.statSync(p); return [s.dev, s.ino, s.birthtimeMs]; }));
    if (identity === this.identity && this.dbs.length) return;
    this.close();
    try { for (const p of this.paths) this.dbs.push(connect(p)); }
    catch (error) { this.close(); throw error; }
    this.identity = identity; this.cache.clear(); this.counters = []; this.versions = []; this.schemaVersion = null; this.lastFull = -Infinity;
  }
  read() {
    this.open();
    for (let attempt = 0; attempt < 3; attempt++) {
      const versions = this.dbs.map(db => db.prepare('PRAGMA data_version').get().data_version);
      const schemaVersion = this.dbs[1].prepare('PRAGMA schema_version').get().schema_version;
      const schemaChanged = schemaVersion !== this.schemaVersion;
      const full = schemaChanged || performance.now() - this.lastFull >= this.config.reconcileIntervalMs;
      if (!full && equal(versions, this.versions) && this.state) return this.state;
      const cache = new Map(this.cache), counters = [], transactions = [];
      let readHeats = this.readHeats;
      try {
        for (const db of this.dbs) { db.exec('BEGIN'); transactions.push(db); }
        if (this.config.autoStandings && schemaChanged) {
          readHeats = discoverHeats(this.dbs[1]);
          if (!readHeats.length) throw new Error('No heat tables available; retrying.');
        }
        const tables = [[0, 'TPARAMETERS'], [0, 'TCOMPETITORS'], ...readHeats.map(h => [1, `TTIMEINFOS_HEAT${h}`])];
        if (this.config.timing.mode !== 'off') {
          for (const h of this.config.autoStandings ? readHeats : [this.config.timing.heat]) {
            const table = `TTIMERECORDS_HEAT${h}_START`;
            if (!this.config.autoStandings || this.dbs[1].prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table)) tables.push([1, table]);
            else cache.delete(`1:${table}`);
          }
        }
        for (const db of this.dbs) counters.push(Object.fromEntries(db.prepare('SELECT TABLENAME,UPDATEVALUE FROM TUPDATEVALUES').all().map(r => [r.TABLENAME, r.UPDATEVALUE])));
        for (const [i, table] of tables) {
          const key = `${i}:${table}`, count = counters[i][table];
          if (!full && cache.has(key) && count !== undefined && count === this.counters[i]?.[table]) continue;
          const sql = table === 'TCOMPETITORS'
            ? 'SELECT C_IDX,C_NUM,C_FIRST_NAME,C_LAST_NAME,C_YEAR,C_CATEGORY,C_CLUB,C_RGPD_DONOTPUBLISH FROM TCOMPETITORS'
            : table === 'TPARAMETERS'
              ? "SELECT C_PARAM,C_VALUE FROM TPARAMETERS WHERE C_PARAM IN ('TITLE1','TITLE2','SOFTWARE_VERSION')"
              : table.startsWith('TTIMERECORDS_') ? `SELECT C_LINE,C_NUM,C_STATUS,C_HOUR2 FROM ${table}` : `SELECT C_NUM,C_STATUS,C_TIME,C_PENALTY FROM ${table}`;
          const rows = this.dbs[i].prepare(sql + ' LIMIT 100001').all();
          if (rows.length > 100000) throw new Error('Too many rows in a VOLA table.');
          cache.set(key, rows); this.tablesRead++;
        }
      } finally { for (const db of transactions.reverse()) db.exec('ROLLBACK'); }
      const after = this.dbs.map(db => db.prepare('PRAGMA data_version').get().data_version);
      if (!equal(versions, after)) continue;
      const state = this.normalize(cache, readHeats);
      this.readHeats = readHeats; this.schemaVersion = schemaVersion;
      this.cache = cache; this.counters = counters; this.versions = after; this.state = state;
      if (full) this.lastFull = performance.now();
      return state;
    }
    throw new Error('Database changed during read; retrying.');
  }
  normalize(cache, readHeats) {
    const params = Object.fromEntries(cache.get('0:TPARAMETERS').map(r => [r.C_PARAM, r.C_VALUE]));
    const eventId = `event-${this.config.event}`, competitors = {}, results = {}, runResults = {}, bibs = new Map(), warnings = [];
    let withheld = 0, penalties = 0;
    for (const r of cache.get('0:TCOMPETITORS')) {
      if (r.C_RGPD_DONOTPUBLISH) { withheld++; continue; }
      const bib = text(r.C_NUM);
      if (!bib || bib === '0') continue;
      if (bibs.has(bib)) throw new Error('Duplicate competitor bibs.');
      const id = `${eventId}:competitor-${r.C_IDX}`;
      bibs.set(bib, id);
      competitors[id] = { id, bib, name: [text(r.C_FIRST_NAME), text(r.C_LAST_NAME)].filter(Boolean).join(' '), category: text(r.C_CATEGORY), club: text(r.C_CLUB), yearOfBirth: /^\d{4}$/.test(text(r.C_YEAR)) ? text(r.C_YEAR) : '' };
    }
    const heats = readHeats.map(h => new Map(cache.get(`1:TTIMEINFOS_HEAT${h}`).map(r => [text(r.C_NUM), r])));
    const valid = validResult;
    const categoryCounts = new Map(Object.values(competitors).map(p => [p.category, this.config.autoStandings ? 1 : heats.length]));
    if (this.config.autoStandings) for (const p of Object.values(competitors)) {
      let count = 0, total = 0;
      for (const h of heats) { const row = h.get(p.bib); if (!valid(row)) break; total += row.C_TIME; if (total > 86400000) break; count++; }
      categoryCounts.set(p.category, Math.max(categoryCounts.get(p.category), count));
    }
    const categoryStandings = [...categoryCounts].map(([category, count]) => ({ category, heats: readHeats.slice(0, count), ranking: count > 1 ? 'total' : 'heat' }));
    let unknown = 0;
    for (const [bib, id] of bibs) {
      const count = categoryCounts.get(competitors[id].category);
      const allRows = heats.map(h => h.get(bib));
      for (let index = allRows.length - 1; index >= 0; index--) {
        const row = allRows[index];
        if (!row || (row.C_PENALTY != null && row.C_PENALTY !== 0)) continue;
        const finished = valid(row);
        if (!finished && ![1, 2, 3].includes(row.C_STATUS)) continue;
        const cumulative = allRows.slice(0, index + 1);
        const total = cumulative.every(valid) ? cumulative.reduce((sum, r) => sum + r.C_TIME, 0) : null;
        const totalEligible = total !== null && total <= 86400000;
        runResults[id] = { id, competitorId: id, bib, heat: readHeats[index], runId: null, status: finished ? 'finish' : { 1: 'dns', 2: 'dnf', 3: 'dsq' }[row.C_STATUS], timeMs: finished ? row.C_TIME : null, totalEligible, totalTimeMs: totalEligible ? total : null };
        break;
      }
      const rows = allRows.slice(0, count).filter(Boolean);
      // A later DNF/DSQ/DNS replaces an earlier finish immediately, but does not switch the category to totals.
      const laterTerminal = this.config.autoStandings && allRows.slice(count).find(r => r && [1, 2, 3].includes(r.C_STATUS));
      if (laterTerminal) rows.push(laterTerminal);
      if (rows.some(r => ![0, 1, 2, 3].includes(r.C_STATUS))) { unknown++; continue; }
      if (rows.some(r => r.C_PENALTY !== null && r.C_PENALTY !== 0)) { penalties++; continue; }
      const terminal = rows.find(r => r.C_STATUS === 3) || rows.find(r => [1, 2].includes(r.C_STATUS));
      let status, timeMs = null;
      if (terminal) status = { 1: 'dns', 2: 'dnf', 3: 'dsq' }[terminal.C_STATUS];
      else if (rows.length === count && rows.every(r => Number.isInteger(r.C_TIME) && r.C_TIME > 0 && r.C_TIME <= 86400000)) {
        timeMs = rows.reduce((n, r) => n + r.C_TIME, 0); status = 'finish';
        if (timeMs > 86400000) continue;
      } else continue;
      results[id] = { id, competitorId: id, bib, status, timeMs };
    }
    if (unknown) warnings.push(`Excluded ${unknown} results with unknown status codes.`);
    if (penalties) warnings.push(`Excluded ${penalties} results with unverified penalties.`);
    if (withheld) warnings.push(`Excluded ${withheld} competitors by publication flag.`);
    return addTiming({ competition: { id: eventId, number: this.config.event, name: text(params.TITLE1).slice(0, 120), subtitle: text(params.TITLE2), sourceVersion: text(params.SOFTWARE_VERSION), heats: readHeats, autoStandings: this.config.autoStandings, categoryStandings, ranking: heats.length > 1 ? 'total' : 'heat', runningTimersSupported: false, warnings }, competitors, results, runResults }, cache, { ...this.config, readHeats });
  }
}
function delta(old, next) {
  const changes = {};
  if (!equal(old.competition, next.competition)) changes.competition = next.competition;
  if (!equal(old.timing, next.timing)) changes.timing = next.timing;
  for (const name of ['competitors', 'results', 'active', 'runResults']) {
    const upsert = Object.entries(next[name]).filter(([id, value]) => !equal(old[name][id], value)).map(([, value]) => value);
    const deleted = Object.keys(old[name]).filter(id => !Object.hasOwn(next[name], id));
    if (upsert.length || deleted.length) changes[name] = { upsert, delete: deleted };
  }
  return changes;
}
module.exports = { VolaReader, discover, delta };
