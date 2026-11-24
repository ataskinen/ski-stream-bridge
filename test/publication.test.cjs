const {test}=require('node:test'),assert=require('node:assert/strict');
const {allowed,inspect}=require('../scripts/check-publication.cjs');
test('publication guard rejects private data and secret-bearing source',()=>{
 for(const p of ['config.json','local/connection-key','Event003.scdb','Event003.SCDB','src/event.sqlite','test/competitors.csv','data/results.json','dist/bridge.zip','src/../config.json'])assert.equal(allowed(p),false,p);
 assert.equal(allowed('src/reader.cjs'),true);
 assert.ok(inspect('src/reader.cjs',Buffer.from('SQLite format 3\0')).length);
 assert.ok(inspect('src/reader.cjs',Buffer.from('/'+'Users'+'/private-user/project')).length);
 assert.ok(inspect('src/reader.cjs',Buffer.from('ghp_'+'x'.repeat(30))).length);
 assert.deepEqual(inspect('src/reader.cjs',Buffer.from('module.exports = {};')),[]);
});
