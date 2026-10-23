import {writeFile,rename,mkdir} from 'node:fs/promises';
const destination='/opt/degen-office/data/charon/discovery.json';
const events=[];let pending=false;
export function publishOfficeDiscovery(raw) {
  if (process.env.CHARON_OFFICE_BRIDGE_ENABLED !== 'true') return;
  if (!raw || !['create','migration','migrate'].includes(raw.txType) || typeof raw.mint!=='string') return;
  const event={receivedAt:Date.now()};
  for(const key of ['mint','txType','signature','txSignature','name','symbol','traderPublicKey']) if(typeof raw[key]==='string')event[key]=raw[key].slice(0,key==='name'?80:100);
  events.push(event);if(events.length>300)events.shift();
  if(pending)return;pending=true;
  setTimeout(async()=>{
    try{await mkdir('/opt/degen-office/data/charon',{recursive:true});await writeFile(destination+'.tmp',JSON.stringify({schemaVersion:1,generatedAt:Date.now(),events}),{mode:0o600});await rename(destination+'.tmp',destination);}
    catch{console.log('[office-feed] projection unavailable');}finally{pending=false;}
  },2000).unref();
}
