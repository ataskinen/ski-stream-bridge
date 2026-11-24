const path=require('node:path'),fs=require('node:fs'),readline=require('node:readline');
const {LiveReplay}=require('../src/live-replay.cjs');
const args=process.argv.slice(2),get=(flag,fallback)=>args.includes(flag)?args[args.indexOf(flag)+1]:fallback;
const folder=path.resolve(get('--folder','local/live-replay')),heat=Number(get('--heat','1'));
if(args.includes('--synthetic'))require('../src/synthetic-replay.cjs').prepareSyntheticReplay(folder,{runTimeMs:Number(get('--run-ms','15000'))});
const replay=new LiveReplay(folder,heat);
replay.reset();
function demoOrder() {
 if(!args.includes('--demo-order'))return;
 const normal=replay.queue.filter(b=>replay.rows.find(r=>r.C_NUM===b)?.C_STATUS===0).slice(0,3);
 const dnf=replay.queue.find(b=>replay.rows.find(r=>r.C_NUM===b)?.C_STATUS===2);
 const dsq=replay.queue.find(b=>replay.rows.find(r=>r.C_NUM===b)?.C_STATUS===3);
 const first=[...normal,dnf,dsq].filter(b=>b!==undefined);
 replay.queue=[...first,...replay.queue.filter(b=>!first.includes(b))];
}
demoOrder();
const d=new Date(),date=[d.getFullYear(),String(d.getMonth()+1).padStart(2,'0'),String(d.getDate()).padStart(2,'0')].join('-');
const configFile=path.join(folder,'config.json'),config=JSON.parse(fs.readFileSync(configFile,'utf8'));
config.heats=replay.plan.heats.filter(h=>h<=heat);config.timing={mode:'simulation',heat,date,utcOffsetMinutes:-d.getTimezoneOffset(),startStatuses:[replay.plan.startStatus ?? 0]};
fs.writeFileSync(configFile,JSON.stringify(config,null,2),{mode:0o600});
let starts=false,last='',closed=false,lastCommand='',lastStatus=0,busy=false,heatDoneAt=null,phase='paused',needsSync=false;
const commandFile=path.join(folder,'simulation-command.json');
try{lastCommand=JSON.parse(fs.readFileSync(commandFile,'utf8')).id;}catch{}
async function syncHeat(next) {
 const url=`http://127.0.0.1:${config.port||8789}`;
 const response=await fetch(url+'/control/state',{signal:AbortSignal.timeout(2000)});
 if(!response.ok)throw Error('Bridge unavailable');
 const state=await response.json();
 const result=await fetch(url+'/control/select',{method:'POST',headers:{'Content-Type':'application/json','X-Control-Token':state.token},body:JSON.stringify({event:replay.plan.event,heats:replay.plan.heats.filter(h=>h<=next),debug:state.debug,simulationHeat:next}),signal:AbortSignal.timeout(3000)});
 if(!result.ok)throw Error('Bridge rejected heat change');
}
async function command(action) {
 if(action==='reset') { starts=false;replay.reset();demoOrder();heatDoneAt=null;phase='paused';needsSync=true; }
 if(needsSync){await syncHeat(replay.heat);needsSync=false;}
 if(action==='resume'){starts=true;phase='running';}
 else if(action==='pause'){starts=false;phase='paused';}
 else if(action==='next')replay.startNext();
}
console.log('Prepared empty multi-heat simulation. Commands: resume, pause, next, reset, quit. Heat changes and results breaks are automatic.');
if(args.includes('--synthetic'))console.log('Start the bridge in another terminal: node src/cli.cjs --config '+path.relative(process.cwd(),configFile));
const timer=setInterval(async()=>{
 if(busy||closed)return;busy=true;
 try {
  let c;try{c=JSON.parse(fs.readFileSync(commandFile,'utf8'));}catch{}
  if(c&&c.id!==lastCommand){lastCommand=c.id;await command(c.action);}
  replay.tick({allowStart:starts&&!needsSync,startIntervalMs:replay.plan.startIntervalMs ?? 5000});
  if(replay.complete) {
   if(!replay.nextHeat){starts=false;phase='complete';}
   else if(starts){
    heatDoneAt??=Date.now();phase='between-heats';
    if(Date.now()-heatDoneAt>=(replay.plan.breakMs ?? 10000)){const next=replay.nextHeat;await syncHeat(next);replay.setHeat(next);heatDoneAt=null;phase='running';}
   }
  }
  if(Date.now()-lastStatus>=500){const file=path.join(folder,'simulation-status.json');fs.writeFileSync(file+'.tmp',JSON.stringify({updatedAt:Date.now(),running:starts,phase,heat:replay.heat,started:replay.index,total:replay.queue.length,onCourse:replay.active.size}));fs.renameSync(file+'.tmp',file);lastStatus=Date.now();}
  const status=JSON.stringify({heat:replay.heat,phase,started:replay.index,total:replay.queue.length,onCourse:replay.active.size});if(status!==last){console.log(status);last=status;}
 }catch{starts=false;phase='error';console.error('Simulation error; new starts paused. Check the bridge, then resume.');}
 finally{busy=false;}
},100);
const rl=readline.createInterface({input:process.stdin});
function close(){if(closed)return;closed=true;clearInterval(timer);replay.close();rl.close();}
rl.on('line',async line=>{
 if(line.trim()==='quit'){close();process.exit(0);}
 // Use the same serialized command path as the browser.
 const file=commandFile+'.tmp';fs.writeFileSync(file,JSON.stringify({id:require('node:crypto').randomUUID(),action:line.trim()}));fs.renameSync(file,commandFile);
});
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{close();process.exit(0);});
