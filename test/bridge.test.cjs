const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { WebSocket } = require('ws');
const { VolaReader, delta } = require('../src/reader.cjs');
const { Bridge } = require('../src/server.cjs');
const { Logger } = require('../src/log.cjs');
const { loadConfig, loadKey } = require('../src/config.cjs');
const pause = ms => new Promise(r => setTimeout(r, ms));
async function until(fn) { for (let n = 0; n < 150; n++) { if (fn()) return; await pause(20); } assert.fail('Condition timed out'); }
function fixture(t) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'ski-bridge-'));
  const cleanups = [];
  t.after(async () => { for (const fn of cleanups.reverse()) await fn(); fs.rmSync(folder, { recursive: true, force: true }); });
  const main = path.join(folder, 'Event001.scdb'), extra = path.join(folder, 'Event001Ex.scdb');
  const edit = (file, sql) => { const db = new DatabaseSync(file); try { db.exec(sql); } finally { db.close(); } };
  edit(main, `CREATE TABLE TPARAMETERS(C_PARAM TEXT PRIMARY KEY,C_VALUE TEXT);
    INSERT INTO TPARAMETERS VALUES ('TITLE1','Example Cup'),('SOFTWARE_VERSION','14.1.04');
    CREATE TABLE TUPDATEVALUES(TABLENAME TEXT PRIMARY KEY,UPDATEVALUE INTEGER);
    INSERT INTO TUPDATEVALUES VALUES ('TPARAMETERS',1),('TCOMPETITORS',1);
    CREATE TABLE TCOMPETITORS(C_IDX INTEGER PRIMARY KEY,C_NUM INTEGER,C_FIRST_NAME TEXT,C_LAST_NAME TEXT,C_YEAR INTEGER,C_CATEGORY TEXT,C_CLUB TEXT,C_RGPD_DONOTPUBLISH INTEGER);
    INSERT INTO TCOMPETITORS VALUES (11,1,'Alex','Example',2016,'U10','Example Club',0),(12,2,'Sam','Sample',2014,'U12','Sample Club',0),(13,3,'Private','Person',2014,'U12','Sample Club',1);`);
  edit(extra, `CREATE TABLE TUPDATEVALUES(TABLENAME TEXT PRIMARY KEY,UPDATEVALUE INTEGER);
    INSERT INTO TUPDATEVALUES VALUES ('TTIMEINFOS_HEAT1',1),('TTIMEINFOS_HEAT2',1);
    CREATE TABLE TTIMEINFOS_HEAT1(C_NUM INTEGER PRIMARY KEY,C_STATUS INTEGER,C_TIME INTEGER,C_PENALTY INTEGER);
    CREATE TABLE TTIMEINFOS_HEAT2(C_NUM INTEGER PRIMARY KEY,C_STATUS INTEGER,C_TIME INTEGER,C_PENALTY INTEGER);
    INSERT INTO TTIMEINFOS_HEAT1 VALUES (1,0,15120,0),(2,0,15400,0),(3,0,14000,0);
    INSERT INTO TTIMEINFOS_HEAT2 VALUES (1,0,15000,0),(2,2,0,0),(3,0,14000,0);`);
  const config = { autoStandings: false, folder, event: 1, heats: [1, 2], reconcileIntervalMs: 5000, pollIntervalMs: 25, bind: '127.0.0.1', port: 0 };
  const reader = new VolaReader(config); cleanups.push(() => reader.close());
  return { folder, main, extra, config, reader, edit, cleanups };
}
test('read-only totals, publication flag, year and cached unchanged reads', t => {
  const { main, extra, reader } = fixture(t);
  const hash = () => [main, extra].map(p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'));
  const before = hash(), s = reader.read();
  assert.equal(Object.keys(s.competitors).length, 2);
  assert.equal(s.competitors['event-1:competitor-11'].yearOfBirth, '2016');
  assert.equal(s.results['event-1:competitor-11'].timeMs, 30120);
  assert.equal(s.results['event-1:competitor-12'].status, 'dnf');
  assert.equal(s.runResults['event-1:competitor-11'].timeMs, 15000);
  assert.equal(s.runResults['event-1:competitor-11'].runId, null);
  assert.equal(s.runResults['event-1:competitor-12'].status, 'dnf');
  assert.equal(s.runResults['event-1:competitor-12'].timeMs, null);
  assert.equal(s.runResults['event-1:competitor-12'].totalTimeMs, null);
  const reads = reader.tablesRead; assert.equal(reader.read(), s); assert.equal(reader.tablesRead, reads);
  assert.throws(() => reader.dbs[0].exec('DELETE FROM TCOMPETITORS'));
  assert.deepEqual(hash(), before);
});
test('counter change sends only result delta; fallback reconciliation handles deleted competitors', t => {
  const { main, extra, reader, edit } = fixture(t); const old = reader.read();
  edit(extra, "UPDATE TTIMEINFOS_HEAT2 SET C_TIME=14000 WHERE C_NUM=1; UPDATE TUPDATEVALUES SET UPDATEVALUE=2 WHERE TABLENAME='TTIMEINFOS_HEAT2';");
  const next = reader.read(), changes = delta(old, next);
  assert.deepEqual(Object.keys(changes), ['results', 'runResults']); assert.equal(changes.results.upsert.length, 1); assert.equal(changes.results.upsert[0].timeMs, 29120);
  edit(main, 'DELETE FROM TCOMPETITORS WHERE C_NUM=1'); reader.lastFull = -Infinity;
  const removed = delta(next, reader.read());
  assert.deepEqual(removed.competitors.delete, ['event-1:competitor-11']); assert.deepEqual(removed.results.delete, ['event-1:competitor-11']);
});
test('unknown statuses/penalties excluded; duplicate bibs and missing heat reject a read', t => {
  const { main, extra, reader, config, edit } = fixture(t);
  edit(extra, 'UPDATE TTIMEINFOS_HEAT1 SET C_STATUS=99 WHERE C_NUM=1; UPDATE TTIMEINFOS_HEAT1 SET C_PENALTY=5 WHERE C_NUM=2');
  const s = reader.read(); assert.equal(Object.keys(s.results).length, 0); assert.equal(s.competition.warnings.length, 3);
  const other = new VolaReader({ ...config, heats: [3] }); try { assert.throws(() => other.read()); } finally { other.close(); }
  edit(main, 'UPDATE TCOMPETITORS SET C_NUM=1 WHERE C_NUM=2'); reader.lastFull = -Infinity; assert.throws(() => reader.read(), /Duplicate/);
});
test('file replacement reopens SQLite connections', t => {
  const { main, reader, edit } = fixture(t); reader.read();
  fs.copyFileSync(main, main + '.new'); edit(main + '.new', "UPDATE TPARAMETERS SET C_VALUE='Replaced Cup' WHERE C_PARAM='TITLE1'");
  // Close for Windows file replacement, while preserving the reader's old cache/identity.
  reader.close(); fs.renameSync(main + '.new', main);
  assert.equal(reader.read().competition.name, 'Replaced Cup');
});
test('config paths resolve relative to config and keys persist without entering example config', t => {
  const { folder } = fixture(t), file = path.join(folder, 'config.json');
  fs.writeFileSync(file, JSON.stringify({ folder: '.', event: 1, heats: [2, 1, 2], debug: true }));
  const c = loadConfig(file); assert.equal(c.folder, folder); assert.deepEqual(c.heats, [1, 2]);
  const key = loadKey(c.keyFile); assert.equal(loadKey(c.keyFile), key); assert.ok(key.length >= 24);
  fs.writeFileSync(file, JSON.stringify({ folder: '.', event: 1, heats: [0] })); assert.throws(() => loadConfig(file));
});
test('debug opt-in, bounded rotation and diagnostic export never include arbitrary fields or payloads', t => {
  const { folder } = fixture(t); const logger = new Logger(path.join(folder, 'logs'), false, 350);
  logger.write('read', { competitors: 2 }, true); assert.equal(fs.existsSync(logger.file), false);
  logger.debug = true;
  for (let i = 0; i < 30; i++) logger.write('read', { durationMs: i, key: 'do-not-export', name: 'Private Person', path: '/private/example', payload: { secret: true } }, true);
  assert.ok(fs.readdirSync(logger.directory).length <= 4);
  const file = path.join(folder, 'diagnostics.json.gz'); logger.export(file);
  const text = zlib.gunzipSync(fs.readFileSync(file)).toString(); const report = JSON.parse(text);
  assert.ok(report.logs.length > 0); assert.ok(report.logs.every(l => l.event === 'read'));
  assert.doesNotMatch(text, /do-not-export|Private Person|private\/example|secret/);
});
test('authenticated WebSocket snapshots, minimal deltas, recovery and reconnect', async t => {
  const { folder, extra, reader, config, edit, cleanups } = fixture(t);
  const logger = new Logger(path.join(folder, 'logs'), true), key = 'test-key-not-a-real-secret';
  const bridge = new Bridge(reader, key, config, logger); await bridge.start();
  cleanups.push(() => bridge.close());
  const url = `http://127.0.0.1:${bridge.server.address().port}`;
  assert.equal((await fetch(url + '/api/v1/snapshot')).status, 401);
  const connect = () => {
    const ws = new WebSocket(url.replace('http:', 'ws:') + '/api/v1/events', { headers: { Authorization: 'Bearer ' + key } });
    const messages = []; ws.on('message', raw => messages.push(JSON.parse(raw))); t.after(() => ws.terminate()); return { ws, messages };
  };
  const a = connect(); await until(() => a.messages.some(m => m.type === 'state.snapshot'));
  const initial = a.messages[0]; assert.equal(Object.keys(initial.state.competitors).length, 2);
  edit(extra, "UPDATE TTIMEINFOS_HEAT2 SET C_TIME=14000 WHERE C_NUM=1; UPDATE TUPDATEVALUES SET UPDATEVALUE=2 WHERE TABLENAME='TTIMEINFOS_HEAT2'");
  await until(() => a.messages.some(m => m.type === 'state.delta'));
  const change = a.messages.find(m => m.type === 'state.delta'); assert.equal(change.baseRevision, initial.revision); assert.deepEqual(Object.keys(change.changes), ['results', 'runResults']);
  a.ws.send(JSON.stringify({ type: 'state.request' })); await until(() => a.messages.filter(m => m.type === 'state.snapshot').length === 2);
  const original = reader.read.bind(reader); reader.read = () => { throw new Error('private message must never be logged'); };
  await until(() => !bridge.health.ok); assert.equal(Object.keys(bridge.state.results).length, 2);
  reader.read = original; await until(() => bridge.health.ok);
  a.ws.terminate(); const b = connect(); await until(() => b.messages.length); assert.equal(b.messages[0].revision, change.revision);
  assert.doesNotMatch(fs.readFileSync(logger.file, 'utf8'), /private message|Alex|Example Club|test-key/);
});
test('local control selects event atomically, persists selection and rejects cross-origin writes', async t => {
  const { folder, main, extra, reader, config, cleanups, edit } = fixture(t);
  fs.copyFileSync(main, path.join(folder, 'Event002.scdb')); fs.copyFileSync(extra, path.join(folder, 'Event002Ex.scdb'));
  edit(path.join(folder, 'Event002.scdb'), "UPDATE TPARAMETERS SET C_VALUE='Second Cup' WHERE C_PARAM='TITLE1'");
  const saved = [], logger = new Logger(path.join(folder, 'logs'));
  const bridge = new Bridge(reader, 'test-key-not-a-real-secret', config, logger, s => saved.push(s));
  await bridge.start(); cleanups.push(() => bridge.close());
  const url = `http://127.0.0.1:${bridge.server.address().port}`;
  const state = await (await fetch(url + '/control/state')).json();
  assert.equal((await (await fetch(url + '/control/events')).json()).events.length, 2);
  const request = (selection, headers = {}) => fetch(url + '/control/select', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Control-Token': state.token, ...headers }, body: JSON.stringify(selection) });
  const oldSession = bridge.sessionId;
  assert.equal((await request({ event: 2, heats: [1], debug: true }, { Origin: 'https://example.org' })).status, 403);
  assert.equal((await request({ event: 2, heats: [3], debug: true })).status, 400);
  assert.equal(bridge.sessionId, oldSession); assert.equal(saved.length, 0);
  assert.equal((await request({ event: 2, heats: [1], debug: true })).status, 200);
  assert.notEqual(bridge.sessionId, oldSession); assert.equal(bridge.state.competition.name, 'Second Cup');
  assert.equal(bridge.state.results['event-2:competitor-11'].timeMs, 15120); assert.equal(saved.length, 1); assert.equal(logger.debug, true);
  const download = await fetch(url + '/control/logs'); assert.equal(download.status, 200);
  assert.doesNotMatch(zlib.gunzipSync(Buffer.from(await download.arrayBuffer())).toString(), /Alex|test-key/);
});
test('archive replay writes only a new copy, starts empty and restores exact results incrementally', async t => {
  const { folder, main, extra, config } = fixture(t);
  const { prepareReplay, Replay } = require('../src/replay.cjs');
  const hashes = () => [main, extra].map(p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'));
  const before = hashes(), out = path.join(folder, 'replay');
  await assert.rejects(prepareReplay(folder, folder, 1));
  await prepareReplay(folder, out, 1);
  await assert.rejects(prepareReplay(folder, out, 1));
  const r = new VolaReader({ ...config, folder: out }), replay = new Replay(out);
  try {
    assert.equal(Object.keys(r.read().results).length, 0);
    assert.equal(replay.step(), true); assert.equal(r.read().results['event-1:competitor-11'].timeMs, 30120);
    assert.equal(Object.keys(r.read().results).length, 1);
    assert.equal(replay.step(), true); assert.equal(r.read().results['event-1:competitor-12'].status, 'dnf');
    while (replay.step()) {}
    replay.reset(); assert.equal(Object.keys(r.read().results).length, 0);
  } finally { replay.close(); r.close(); }
  assert.deepEqual(hashes(), before);
});
test('simulation START rows produce concurrent clocks, archived terminals remove racers and last start survives reconnect', async t => {
  const {folder,config}=fixture(t);
  const {prepareReplay}=require('../src/replay.cjs'),{LiveReplay}=require('../src/live-replay.cjs');
  const out=path.join(folder,'live-replay');await prepareReplay(folder,out,1);
  let now=Date.now()-60000;const d=new Date(now);const date=[d.getFullYear(),String(d.getMonth()+1).padStart(2,'0'),String(d.getDate()).padStart(2,'0')].join('-');
  const live=new LiveReplay(out,1,()=>now);live.reset();
  const c={...config,folder:out,heats:[1],timing:{mode:'simulation',heat:1,date,utcOffsetMinutes:-d.getTimezoneOffset(),startStatuses:[0]}};
  const reader=new VolaReader(c);
  try {
    assert.equal(Object.keys(reader.read().active).length,0);
    live.startNext();assert.equal(Object.keys(reader.read().active).length,1);
    now+=1000;live.startNext();const s=reader.read();assert.equal(Object.keys(s.active).length,2);assert.equal(s.timing.lastStartAtMs,now);
    const first=s.active['event-1:competitor-11'];assert.equal(first.startedAtMs,now-1000);
    now+=16000;live.tick({allowStart:false});const final=reader.read();assert.equal(Object.keys(final.active).length,0);assert.equal(final.results['event-1:competitor-11'].timeMs,15120);
    reader.close();assert.equal(reader.read().timing.lastStartAtMs,s.timing.lastStartAtMs);
    live.reset();assert.equal(Object.keys(reader.read().results).length,0);assert.equal(Object.keys(reader.read().active).length,0);
  }finally{reader.close();live.close();}
});
test('simulation commands are local, token protected and unavailable for real timing sources', async t => {
 const {folder,reader,config,cleanups}=fixture(t);const bridge=new Bridge(reader,'test-key-not-a-real-secret',config,new Logger(path.join(folder,'logs')));
 await bridge.start();cleanups.push(()=>bridge.close());const url=`http://127.0.0.1:${bridge.server.address().port}`;
 const {token}=await(await fetch(url+'/control/state')).json();
 const send=(action,headers={})=>fetch(url+'/control/simulation',{method:'POST',headers:{'Content-Type':'application/json','X-Control-Token':token,...headers},body:JSON.stringify({action})});
 assert.equal((await send('reset')).status,403);
 bridge.config={...bridge.config,timing:{mode:'simulation'}};
 assert.equal((await send('resume')).status,409);
 fs.writeFileSync(path.join(folder,'simulation-status.json'),JSON.stringify({updatedAt:Date.now(),running:false,started:0,total:3,onCourse:0}));
 assert.equal((await send('resume',{'X-Control-Token':'wrong'})).status,403);
 assert.equal((await send('resume',{Origin:'https://example.org'})).status,403);
 assert.equal((await send('invalid')).status,400);
 assert.equal((await send('resume')).status,200);
 assert.equal(JSON.parse(fs.readFileSync(path.join(folder,'simulation-command.json'),'utf8')).action,'resume');
});
test('multi-heat simulation restores every archived result and reset returns to the first heat', async t => {
 const {folder,config}=fixture(t);
 const {prepareReplay}=require('../src/replay.cjs'),{LiveReplay}=require('../src/live-replay.cjs');
 const source=new VolaReader(config),expected=source.read();source.close();
 const out=path.join(folder,'all-heats');await prepareReplay(folder,out,1);
 let now=Date.now()-86400000;const live=new LiveReplay(out,1,()=>now);
 live.reset();
 try {
  let heats=0;
  do {
   if(heats)live.setHeat(live.nextHeat);
   while(!live.complete){live.tick();now+=5000;}
   heats++;
  }while(live.nextHeat);
  assert.equal(heats,2);
  const reader=new VolaReader({...config,folder:out});
  try{assert.deepEqual(reader.read().results,expected.results);}finally{reader.close();}
  live.reset();assert.equal(live.heat,1);assert.equal(live.index,0);assert.equal(live.active.size,0);
 }finally{live.close();}
});
test('automatic standings switch independently by category, exclude incomplete totals and recover after corrections', t => {
 const {config,extra,main,edit,cleanups}=fixture(t);
 edit(main,"INSERT INTO TCOMPETITORS VALUES(14,4,'Other','Racer',2016,'U10','Club',0); UPDATE TUPDATEVALUES SET UPDATEVALUE=UPDATEVALUE+1 WHERE TABLENAME='TCOMPETITORS';");
 edit(extra,'DELETE FROM TTIMEINFOS_HEAT2; INSERT INTO TTIMEINFOS_HEAT1 VALUES(4,0,16000,0);');
 const reader=new VolaReader({...config,heats:[1],autoStandings:true});cleanups.push(()=>reader.close());
 const result=(s,n)=>s.results['event-1:competitor-'+n];
 const category=(s,c)=>s.competition.categoryStandings.find(x=>x.category===c);
 const update=sql=>edit(extra,sql+"; UPDATE TUPDATEVALUES SET UPDATEVALUE=UPDATEVALUE+1 WHERE TABLENAME='TTIMEINFOS_HEAT2'");
 let s=reader.read();assert.equal(result(s,11).timeMs,15120);assert.equal(result(s,12).timeMs,15400);assert.equal(category(s,'U10').ranking,'heat');
 update('INSERT INTO TTIMEINFOS_HEAT2 VALUES(1,2,0,0)');s=reader.read();assert.equal(result(s,11).status,'dnf');assert.equal(category(s,'U10').ranking,'heat');assert.equal(result(s,14).timeMs,16000);
 update('UPDATE TTIMEINFOS_HEAT2 SET C_STATUS=0,C_TIME=15000 WHERE C_NUM=1');s=reader.read();assert.equal(result(s,11).timeMs,30120);assert.equal(result(s,14),undefined);assert.equal(result(s,12).timeMs,15400);assert.equal(category(s,'U10').ranking,'total');assert.equal(category(s,'U12').ranking,'heat');
 update('INSERT INTO TTIMEINFOS_HEAT2 VALUES(4,3,0,0)');s=reader.read();assert.equal(result(s,14).status,'dsq');assert.equal(category(s,'U10').ranking,'total');
 reader.close();s=reader.read();assert.equal(category(s,'U10').ranking,'total');
 update('UPDATE TTIMEINFOS_HEAT2 SET C_STATUS=3,C_TIME=0 WHERE C_NUM=1');s=reader.read();assert.equal(category(s,'U10').ranking,'heat');assert.equal(result(s,11).status,'dsq');
});
test('automatic timing detects second-heat starts and adds the first time without changing configured heat', t => {
 const {config,extra,edit,cleanups}=fixture(t);const now=Date.now()-10000,d=new Date(now);
 const date=[d.getFullYear(),String(d.getMonth()+1).padStart(2,'0'),String(d.getDate()).padStart(2,'0')].join('-');
 const micros=((d.getHours()*3600+d.getMinutes()*60+d.getSeconds())*1000+d.getMilliseconds())*1000;
 edit(extra,`DELETE FROM TTIMEINFOS_HEAT2; CREATE TABLE TTIMERECORDS_HEAT2_START(C_LINE INTEGER,C_NUM INTEGER,C_STATUS INTEGER,C_HOUR2 TEXT); INSERT INTO TTIMERECORDS_HEAT2_START VALUES(1,1,0,'${micros}');`);
 const reader=new VolaReader({...config,heats:[1],autoStandings:true,timing:{mode:'simulation',heat:1,date,utcOffsetMinutes:-d.getTimezoneOffset(),startStatuses:[0]}});cleanups.push(()=>reader.close());
 const s=reader.read(),active=s.active['event-1:competitor-11'];assert.equal(active.baseTimeMs,15120);assert.equal(active.startedAtMs,now);assert.match(active.runId,/^2:/);assert.equal(s.competition.categoryStandings.find(x=>x.category==='U10').ranking,'heat');
});
test('automatic reader discovers heat tables created mid-race and keeps manual selections', t => {
 const {config,extra,edit,cleanups}=fixture(t);
 edit(extra,'DROP TABLE TTIMEINFOS_HEAT2');
 const timing={mode:'simulation',heat:1,date:'2026-01-01',utcOffsetMinutes:0,startStatuses:[0]};
 const reader=new VolaReader({...config,heats:[1],autoStandings:true,timing});
 const manual=new VolaReader({...config,heats:[1],timing:{mode:'off'}});
 cleanups.push(()=>reader.close(),()=>manual.close());
 const first=reader.read(),manualFirst=manual.read();
 assert.deepEqual(first.competition.heats,[1]);assert.equal(first.results['event-1:competitor-11'].timeMs,15120);
 const reads=reader.tablesRead;
 // VOLA may create result and START tables in separate schema updates.
 edit(extra,'CREATE TABLE TTIMEINFOS_HEAT2(C_NUM INTEGER PRIMARY KEY,C_STATUS INTEGER,C_TIME INTEGER,C_PENALTY INTEGER)');
 assert.deepEqual(reader.read().competition.heats,[1,2]);assert.equal(reader.tablesRead-reads,4);
 edit(extra,`CREATE TABLE TTIMERECORDS_HEAT2_START(C_LINE INTEGER,C_NUM INTEGER,C_STATUS INTEGER,C_HOUR2 TEXT);
 INSERT INTO TTIMERECORDS_HEAT2_START VALUES(1,1,0,'36000000000');`);
 const started=reader.read(),active=started.active['event-1:competitor-11'];
 assert.equal(active.baseTimeMs,15120);assert.equal(active.startedAtMs,Date.parse('2026-01-01T10:00:00Z'));assert.match(active.runId,/^2:/);
 assert.equal(started.results['event-1:competitor-11'].timeMs,15120);
 assert.equal(reader.config.timing.heat,1);assert.deepEqual(reader.config.heats,[1]);
 edit(extra,`INSERT INTO TTIMEINFOS_HEAT2 VALUES(1,0,15000,0);
 UPDATE TUPDATEVALUES SET UPDATEVALUE=UPDATEVALUE+1 WHERE TABLENAME='TTIMEINFOS_HEAT2';`);
 const finished=reader.read();assert.equal(finished.results['event-1:competitor-11'].timeMs,30120);assert.deepEqual(finished.active,{});
 assert.equal(finished.competition.categoryStandings.find(x=>x.category==='U10').ranking,'total');
 assert.deepEqual(manual.read(),manualFirst);assert.deepEqual(manual.readHeats,[1]);
 assert.equal(reader.read(),finished);
});
test('incomplete new heat schema retains the applied state and retries after repair', t => {
 const {config,extra,edit,cleanups}=fixture(t);
 edit(extra,'DROP TABLE TTIMEINFOS_HEAT2');
 const reader=new VolaReader({...config,heats:[1],autoStandings:true});cleanups.push(()=>reader.close());
 const first=reader.read(),schemaVersion=reader.schemaVersion;
 edit(extra,'CREATE TABLE TTIMEINFOS_HEAT2(C_NUM INTEGER PRIMARY KEY)');
 assert.throws(()=>reader.read(),/no such column/);
 assert.throws(()=>reader.read(),/no such column/);
 assert.equal(reader.state,first);assert.deepEqual(reader.readHeats,[1]);assert.equal(reader.schemaVersion,schemaVersion);
 edit(extra,`ALTER TABLE TTIMEINFOS_HEAT2 ADD COLUMN C_STATUS INTEGER;
 ALTER TABLE TTIMEINFOS_HEAT2 ADD COLUMN C_TIME INTEGER;
 ALTER TABLE TTIMEINFOS_HEAT2 ADD COLUMN C_PENALTY INTEGER;
 INSERT INTO TTIMEINFOS_HEAT2 VALUES(1,0,15000,0);`);
 const repaired=reader.read();assert.deepEqual(repaired.competition.heats,[1,2]);assert.equal(repaired.results['event-1:competitor-11'].timeMs,30120);
 assert.notEqual(reader.schemaVersion,schemaVersion);assert.equal(reader.read(),repaired);
});
test('individual second-run outcomes retain matching start identity and official cumulative totals', t => {
 const {config,extra,edit,cleanups}=fixture(t);
 edit(extra,`DELETE FROM TTIMEINFOS_HEAT2;
 CREATE TABLE TTIMERECORDS_HEAT1_START(C_LINE INTEGER,C_NUM INTEGER,C_STATUS INTEGER,C_HOUR2 TEXT);
 INSERT INTO TTIMERECORDS_HEAT1_START VALUES(4,1,0,'32400000000');
 CREATE TABLE TTIMERECORDS_HEAT2_START(C_LINE INTEGER,C_NUM INTEGER,C_STATUS INTEGER,C_HOUR2 TEXT);
 INSERT INTO TTIMERECORDS_HEAT2_START VALUES(7,1,0,'36000000000');`);
 const reader=new VolaReader({...config,heats:[1],autoStandings:true,timing:{mode:'simulation',heat:1,date:'2026-01-01',utcOffsetMinutes:0,startStatuses:[0]}});cleanups.push(()=>reader.close());
 const id='event-1:competitor-11',started=reader.read(),active=started.active[id];
 assert.equal(active.heat,2);assert.equal(active.totalEligible,true);assert.equal(active.baseTimeMs,15120);
 assert.equal(started.runResults[id].heat,1);assert.equal(started.runResults[id].timeMs,15120);assert.match(started.runResults[id].runId,/^1:4:/);assert.notEqual(started.runResults[id].runId,active.runId);
 edit(extra,`INSERT INTO TTIMEINFOS_HEAT2 VALUES(1,0,15000,0);UPDATE TUPDATEVALUES SET UPDATEVALUE=UPDATEVALUE+1 WHERE TABLENAME='TTIMEINFOS_HEAT2'`);
 const finished=reader.read(),run=finished.runResults[id];
 assert.equal(finished.active[id],undefined);assert.equal(run.heat,2);assert.equal(run.runId,active.runId);
 assert.equal(run.timeMs,15000);assert.equal(run.totalTimeMs,30120);assert.equal(run.totalEligible,true);
 assert.equal(finished.results[id].timeMs,30120);assert.equal(finished.runResults['event-1:competitor-13'],undefined);
 const changes=delta(started,finished);assert.equal(changes.runResults.upsert.find(r=>r.id===id).timeMs,15000);
 reader.close();assert.deepEqual(reader.read().runResults,finished.runResults);
 edit(extra,`DELETE FROM TTIMEINFOS_HEAT1 WHERE C_NUM=1;DELETE FROM TTIMEINFOS_HEAT2 WHERE C_NUM=1;
 UPDATE TUPDATEVALUES SET UPDATEVALUE=UPDATEVALUE+1;`);
 assert.deepEqual(delta(finished,reader.read()).runResults.delete,[id]);
});
test('second-run clocks and individual finishes remain available without a valid first run', t => {
 for(const invalid of ['DELETE FROM TTIMEINFOS_HEAT1 WHERE C_NUM=1','UPDATE TTIMEINFOS_HEAT1 SET C_STATUS=2,C_TIME=0 WHERE C_NUM=1','UPDATE TTIMEINFOS_HEAT1 SET C_PENALTY=10 WHERE C_NUM=1','UPDATE TTIMEINFOS_HEAT1 SET C_STATUS=99 WHERE C_NUM=1','UPDATE TTIMEINFOS_HEAT1 SET C_TIME=0 WHERE C_NUM=1','UPDATE TTIMEINFOS_HEAT1 SET C_TIME=86400001 WHERE C_NUM=1']) {
  const {config,extra,edit,cleanups}=fixture(t);
  edit(extra,invalid+`;DELETE FROM TTIMEINFOS_HEAT2;
  CREATE TABLE TTIMERECORDS_HEAT2_START(C_LINE INTEGER,C_NUM INTEGER,C_STATUS INTEGER,C_HOUR2 TEXT);
  INSERT INTO TTIMERECORDS_HEAT2_START VALUES(1,1,0,'36000000000');`);
  const reader=new VolaReader({...config,heats:[1],autoStandings:true,timing:{mode:'simulation',heat:1,date:'2026-01-01',utcOffsetMinutes:0,startStatuses:[0]}});cleanups.push(()=>reader.close());
  const id='event-1:competitor-11',active=reader.read().active[id];
  assert.equal(active.heat,2);assert.equal(active.totalEligible,false);assert.equal(active.baseTimeMs,0);
  edit(extra,`INSERT INTO TTIMEINFOS_HEAT2 VALUES(1,0,15000,0);UPDATE TUPDATEVALUES SET UPDATEVALUE=UPDATEVALUE+1 WHERE TABLENAME='TTIMEINFOS_HEAT2'`);
  const state=reader.read(),run=state.runResults[id];
  assert.equal(state.active[id],undefined);assert.equal(run.timeMs,15000);assert.equal(run.status,'finish');
  assert.equal(run.totalEligible,false);assert.equal(run.totalTimeMs,null);assert.equal(run.runId,active.runId);
  assert.notEqual(state.results[id]?.timeMs,15000);
 }
});
test('local competition selection needs no standings field and defaults to automatic mode', async t => {
 const {reader,config,folder,cleanups}=fixture(t);const bridge=new Bridge(reader,'test-key-not-a-real-secret',config,new Logger(path.join(folder,'logs')));
 await bridge.start();cleanups.push(()=>bridge.close());const url=`http://127.0.0.1:${bridge.server.address().port}`;
 const {token}=await(await fetch(url+'/control/state')).json();
 const res=await fetch(url+'/control/select',{method:'POST',headers:{'Content-Type':'application/json','X-Control-Token':token},body:JSON.stringify({event:1,autoStandings:true,debug:false})});
 assert.equal(res.status,200);assert.equal(bridge.state.competition.autoStandings,true);assert.deepEqual(bridge.state.competition.heats,[1,2]);
 assert.doesNotMatch(require('../src/control.cjs').html,/<select id="heats"/);
});
test('settings UI validates before saving, keeps keys private, and preserves a working source on failure', async t => {
 const {reader,config,folder,cleanups}=fixture(t);let saved=[],failSave=false;
 const bridge=new Bridge(reader,'test-key-not-a-real-secret',config,new Logger(path.join(folder,'logs')),s=>{if(failSave)throw Error('disk full');saved.push(s);});
 await bridge.start();cleanups.push(()=>bridge.close());const url=`http://127.0.0.1:${bridge.server.address().port}`;
 const {token}=await(await fetch(url+'/control/state')).json();
 const post=(route,data,headers={})=>fetch(url+route,{method:'POST',headers:{'Content-Type':'application/json','X-Control-Token':token,...headers},body:JSON.stringify(data)});
 const settings={folder,event:1,bind:'127.0.0.1',port:bridge.server.address().port,pollIntervalMs:250,reconcileIntervalMs:1000,logDirectory:path.join(folder,'new-logs'),debug:true,timing:{mode:'off'}};
 assert.equal((await post('/control/key',{}, {'X-Control-Token':'invalid'})).status,403);
 assert.equal((await post('/control/key',{}, {Origin:'https://evil.example'})).status,403);
 assert.equal((await(await post('/control/key',{})).json()).key,'test-key-not-a-real-secret');
 assert.doesNotMatch(await(await fetch(url+'/control/settings')).text(),/test-key|keyFile/);
 assert.equal((await(await post('/control/folder',{folder})).json()).events.length,1);
 assert.equal((await post('/control/folder',{folder:path.join(folder,'missing')})).status,400);
 for(const bad of [{port:70000},{pollIntervalMs:0},{folder:path.join(folder,'missing')},{event:999},{timing:{mode:'records',heat:1,date:'bad',utcOffsetMinutes:0,startStatuses:[0]}}])assert.equal((await post('/control/settings',{...settings,...bad})).status,400);
 assert.equal(saved.length,0);assert.equal(bridge.health.ok,true);
 failSave=true;assert.equal((await post('/control/settings',settings)).status,400);assert.equal(bridge.config.reconcileIntervalMs,5000);
 failSave=false;assert.equal((await post('/control/settings',settings)).status,200);assert.equal(saved.length,1);assert.equal(bridge.config.reconcileIntervalMs,1000);assert.equal(bridge.log.directory,settings.logDirectory);assert.equal(bridge.config.autoStandings,true);
 new (require('node:vm').Script)(require('../src/control.cjs').script);
});
test('network settings restart listeners, reject occupied ports and roll back failed persistence', async t => {
 const {reader,config,folder,cleanups}=fixture(t);let failSave=false;
 const bridge=new Bridge(reader,'test-key-not-a-real-secret',config,new Logger(path.join(folder,'logs')),()=>{if(failSave)throw Error('save failed');});
 await bridge.start();cleanups.push(()=>bridge.close());let port=bridge.server.address().port;
 const send=async(data)=>{const url=`http://127.0.0.1:${port}`;const {token}=await(await fetch(url+'/control/state')).json();return fetch(url+'/control/settings',{method:'POST',headers:{'Content-Type':'application/json','X-Control-Token':token},body:JSON.stringify(data)});};
 const settings={folder,event:1,bind:'127.0.0.1',port,pollIntervalMs:250,reconcileIntervalMs:1000,logDirectory:path.join(folder,'logs'),debug:false,timing:{mode:'off'}};
 const blocker=require('node:http').createServer();await new Promise(r=>blocker.listen(0,'127.0.0.1',r));cleanups.push(()=>new Promise(r=>blocker.close(r)));const occupied=blocker.address().port;
 assert.equal((await send({...settings,port:occupied})).status,400);assert.equal(bridge.server.address().port,port);
 failSave=true;assert.equal((await send({...settings,bind:'0.0.0.0'})).status,400);assert.equal(bridge.server.address().address,'127.0.0.1');
 failSave=false;assert.equal((await send({...settings,bind:'0.0.0.0'})).status,200);assert.equal(bridge.server.address().address,'0.0.0.0');
 await new Promise(r=>blocker.close(r));const res=await send({...settings,port:occupied});assert.equal(res.status,200);assert.equal((await res.json()).controlUrl,`http://127.0.0.1:${occupied}/`);port=occupied;
 assert.equal((await fetch(`http://127.0.0.1:${port}/control/state`)).status,200);
});
test('CLI keeps setup reachable when its VOLA folder is missing', async t => {
 const {folder}=fixture(t);const http=require('node:http'),{spawn}=require('node:child_process');
 const probe=http.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
 const file=path.join(folder,'setup.json');fs.writeFileSync(file,JSON.stringify({folder:path.join(folder,'not-configured'),event:1,port,logDirectory:path.join(folder,'logs'),keyFile:path.join(folder,'key')}));
 const child=spawn(process.execPath,[path.resolve('src/cli.cjs'),'--config',file],{stdio:'ignore'});
 t.after(async()=>{if(child.exitCode===null){const exited=new Promise(r=>child.once('exit',r));child.kill();await exited;}});
 let state;for(let i=0;i<80;i++){try{state=await(await fetch(`http://127.0.0.1:${port}/control/state`)).json();break;}catch{await pause(25);}}
 assert.ok(state);assert.equal(state.health.ok,false);
 assert.deepEqual((await(await fetch(`http://127.0.0.1:${port}/control/events`)).json()).events,[]);
 assert.equal((await fetch(`http://127.0.0.1:${port}/control/settings`)).status,200);
});
