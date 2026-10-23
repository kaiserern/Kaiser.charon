// Local paper-data bridge. No wallet keys or transaction execution methods.
import net from 'node:net';
import {mkdirSync,chmodSync,existsSync,unlinkSync,lstatSync} from 'node:fs';
const path='/opt/degen-office/data/charon/feed.sock';
export class OfficeBroker {
  constructor(){this.upstream=null;this.client=null;this.remaining=0;this.desired=[];this.active=[];this.grants=new Set();this.rejected='';this.buffer='';}
  write(value){if(!this.client||this.client.destroyed)return;if(this.client.writableLength>1024*1024){this.client.destroy();return;}this.client.write(JSON.stringify(value)+'\n');}
  status(){this.write({type:'status',at:Date.now(),upstream:this.upstream?.readyState===1,remaining:this.remaining,subscribed:this.active,reason:this.rejected});}
  send(method,keys){if(keys.length&&this.upstream?.readyState===1)this.upstream.send(JSON.stringify({method,keys}));}
  update(){const next=this.remaining>100&&!this.rejected?this.desired:[];this.send('unsubscribeTokenTrade',this.active.filter(m=>!next.includes(m)));this.send('subscribeTokenTrade',next.filter(m=>!this.active.includes(m)));this.active=this.upstream?.readyState===1?[...next]:[];this.status();}
  attach(ws){this.upstream=ws;this.active=[];this.rejected='';this.update();}
  disconnect(){this.upstream=null;this.active=[];this.status();}
  command(raw){
    if(raw.type==='grant'&&typeof raw.id==='string'&&raw.id.length<=80&&raw.events===10000&&!this.grants.has(raw.id)&&this.remaining<=500){this.grants.add(raw.id);this.remaining+=10000;this.update();}
    if(raw.type==='watch'&&Array.isArray(raw.mints)&&raw.mints.length<=5&&raw.mints.every(m=>typeof m==='string'&&/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(m))){this.desired=[...new Set(raw.mints)];this.update();}
  }
  publish(raw){
    if(!raw)return;
    const message=typeof raw==='string'?raw:String(raw.message||'');
    if(raw.error||raw.errors||/insufficient|not enough|balance|fund(?:ed| your)|invalid api|unauthorized/i.test(message)){
      this.rejected=/balance|fund|insufficient|not enough/i.test(JSON.stringify(raw))?'provider_funding_required':'provider_subscription_rejected';this.update();return;
    }
    if(!this.client)return;
    const trade=['buy','sell'].includes(raw.txType);
    if(trade){if(!this.active.includes(raw.mint))return;this.remaining--;if(this.remaining<=100){this.update();return;}}
    if(!trade&&!['create','migrate','migration'].includes(raw.txType))return;
    const event={receivedAt:Date.now()};
    for(const key of ['mint','txType','signature','txSignature','name','symbol','traderPublicKey','vSolInBondingCurve','vTokensInBondingCurve','marketCapSol','solAmount','tokenAmount','pool']){
      if(typeof raw[key]==='string')event[key]=raw[key].slice(0,key==='name'?80:128);
      else if(typeof raw[key]==='number'&&Number.isFinite(raw[key]))event[key]=raw[key];
    }
    this.write({type:'event',at:Date.now(),event});
    if(trade&&this.remaining<=500)this.status();
  }
  accept(client){
    if(this.client&&!this.client.destroyed){client.destroy();return;}
    this.client=client;this.desired=[];this.active=[];this.buffer='';client.setEncoding('utf8');this.status();
    client.on('data',chunk=>{this.buffer+=chunk;if(this.buffer.length>16384){client.destroy();return;}let i;while((i=this.buffer.indexOf('\n'))>=0){const line=this.buffer.slice(0,i);this.buffer=this.buffer.slice(i+1);try{this.command(JSON.parse(line));}catch{client.destroy();return;}}});
    const close=()=>{if(this.client!==client)return;this.send('unsubscribeTokenTrade',this.active);this.active=[];this.desired=[];this.client=null;};
    client.on('close',close);client.on('error',close);
  }
}
export const officeBroker=new OfficeBroker();
let brokerServer;
export function startOfficeBroker(){
  if(process.env.CHARON_OFFICE_BRIDGE_ENABLED !== 'true')return null;
  if(brokerServer)return brokerServer;
  mkdirSync('/opt/degen-office/data/charon',{recursive:true});
  if(existsSync(path)){if(!lstatSync(path).isSocket())throw new Error('Office bridge path is not a socket');unlinkSync(path);}
  const server=brokerServer=net.createServer(client=>officeBroker.accept(client));server.on('error',()=>console.log('[office-broker] local socket unavailable'));server.listen(path,()=>chmodSync(path,0o600));
  setInterval(()=>officeBroker.status(),5000).unref();return server;
}
