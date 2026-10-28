/* Pure static P2P multiplayer: WebRTC host-authoritative rooms without any backend.
 * Modeled on smallFarm's net.js. The host browser runs the authoritative HistoryGame;
 * guests send commands over the data channel and render per-seat snapshots.
 * The snapshot/command semantics mirror game_server.cjs so the existing UI works
 * unchanged. Designed for GitHub Pages and other static hosting.
 */
(function (root) {
'use strict';
const APP_ID='iteration-board-game';
const APP_PASSWORD='iteration-board-game';
const ALPHABET='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const HOST_KEY='iteration-table-v4-p2p-host-v1';
const TRYSTERO_URLS=['https://esm.sh/trystero@0.26.0','https://cdn.jsdelivr.net/npm/trystero@0.26.0/+esm'];
const WEBCONNECT_URL='https://cdn.jsdelivr.net/npm/webconnect/dist/umd/webconnect.js';
const P2P_DEFAULT='auto';

/* ---------- utilities ---------- */
function randCode(len){const a=new Uint32Array(len);crypto.getRandomValues(a);let s='';for(let i=0;i<len;i++)s+=ALPHABET[a[i]%ALPHABET.length];return s;}
function randToken(){const a=new Uint8Array(16);crypto.getRandomValues(a);return Array.from(a,b=>b.toString(16).padStart(2,'0')).join('');}
function clone(x){return JSON.parse(JSON.stringify(x));}
// Non-cryptographic signature: only used to detect duplicate command submissions.
function digest(x){let h=2166136261;for(let i=0;i<x.length;i++){h^=x.charCodeAt(i);h=Math.imul(h,16777619);}return (h>>>0).toString(36);}

/* ---------- transport: webConnect (UMD fallback) ---------- */
function loadScript(src){return new Promise((resolve,reject)=>{const s=document.createElement('script');s.src=src;s.onload=()=>resolve();s.onerror=()=>reject(new Error('加载 P2P 库失败'));document.head.appendChild(s);});}
async function connectWebConnect(roomId, events){
  if(typeof window.webconnect!=='function')await loadScript(WEBCONNECT_URL);
  const conn=window.webconnect({
    appName:APP_ID,channelName:roomId,connectPassword:APP_PASSWORD,
    mqttBrokers:[],torrentTrackers:[],
    nostrRelays:['wss://relay.damus.io','wss://nos.lol','wss://offchain.pub','wss://nostr.mom']
  });
  const t={name:'webconnect',selfId:null,sendTo:(peerId,msg)=>conn.Send(msg,{connectId:peerId}),broadcast:msg=>conn.Send(msg,{connectId:null}),leave:()=>{try{conn.Disconnect();}catch{}}};
  conn.getMyId(attr=>{t.selfId=attr.connectId;});
  conn.onConnect(attr=>events.onPeerJoin(attr.connectId));
  conn.onDisconnect(attr=>events.onPeerLeave(attr.connectId));
  conn.onReceive((data,attr)=>events.onMessage(data,attr.connectId));
  return t;
}

/* ---------- transport: Trystero (ESM, default) ---------- */
async function connectTrystero(roomId, events){
  let mod=null,lastErr=null;
  for(const url of TRYSTERO_URLS){try{mod=await import(url);break;}catch(e){lastErr=e;}}
  if(!mod)throw lastErr||new Error('加载 Trystero 失败');
  const room=mod.joinRoom({appId:APP_ID},roomId);
  const action=room.makeAction('msg');
  const t={name:'trystero',selfId:mod.selfId,sendTo:(peerId,msg)=>action.send(msg,{target:peerId}),broadcast:msg=>action.send(msg),leave:()=>{try{room.leave();}catch{}}};
  action.onMessage=(payload,meta)=>events.onMessage(payload,meta.peerId);
  room.onPeerJoin=peerId=>events.onPeerJoin(peerId);
  room.onPeerLeave=peerId=>events.onPeerLeave(peerId);
  return t;
}

function resolveLib(){const p=new URLSearchParams(location.search).get('p2p');if(p==='webconnect'||p==='trystero')return p;return P2P_DEFAULT;}
async function connectTransport(roomId, events){
  const lib=resolveLib();
  if(lib==='webconnect')return connectWebConnect(roomId,events);
  try{return await connectTrystero(roomId,events);}
  catch(e){if(lib==='trystero')throw e;return connectWebConnect(roomId,events);}
}

/* ---------- host room state (mirrors game_server.cjs room object) ---------- */
function createRoomState(id,roomName,capacity,mode,data){
  const now=new Date().toISOString();
  const legend=mode==='legend',quick=mode==='quick',experimental=mode==='experimental';
  const rules=legend?GameConfig.legendRules():experimental?(GameConfig.defaults()):GameConfig.defaults();
  return {id,roomName:roomName||'更迭房间',capacity,listed:false,allowSpectators:true,quick,legend,experimental,rules,rulesVersion:0,version:1,seats:[],game:null,receipts:[],createdAt:now,startedAt:null,metrics:{}};
}
function snapshot(r,seat,now=Date.now()){
  // GameConfig/Flow 是全局词法绑定（浏览器内联 script 的顶层 const），
  // 不是 window 上的属性；Node 测试里通过 globalThis 提供，直接引用即可。
  return {
    quick:!!r.quick,legend:!!r.legend,allowSpectators:r.allowSpectators===true,spectator:seat===null,room:r.id,experimental:!!r.experimental,
    roomName:r.roomName||(r.seats[0]?r.seats[0].name+'的房间':'更迭房间'),listed:!!r.listed,createdAt:r.createdAt,startedAt:r.startedAt||null,
    metrics:r.metrics||null,seat,host:seat===0,capacity:r.capacity,version:r.version,started:!!r.game,rulesVersion:r.rulesVersion||0,
    rules:r.game?r.game.rules():(r.legend?GameConfig.legendRules():r.experimental?r.rules:GameConfig.defaults()),
    preferences:{pauseDice:r.seats[seat]?r.seats[seat].pauseDice!==false:true,pausePurchase:r.seats[seat]?r.seats[seat].pausePurchase!==false:true},
    seats:r.seats.map((s,i)=>({name:s.name,seat:i,ready:s.ready,online:now-s.seen<15000})),
    ...(r.game?{view:r.game.view(seat),quotes:seat===null?{research:{},events:{},available:[]}:Flow.quotes(r.game,seat)}:{})
  };
}

/* ---------- connection ---------- */
class TabletopP2PConnection{
  constructor(id,options){
    Object.assign(this,{
      id,data:options.data,isHost:!!options.isHost,roomState:options.roomState||null,
      onSnapshot:options.onSnapshot||(()=>{}),onStatus:options.onStatus||(()=>{}),onError:options.onError||(()=>{}),
      save:options.save||(()=>{}),schedule:options.schedule||((fn,ms)=>setTimeout(fn,ms)),cancel:options.cancel||(t=>clearTimeout(t)),
      hostStateKey:options.hostStateKey||HOST_KEY
    });
    this.closed=false;this.busy=false;this.polling=false;this.pending=null;this.pendingResolve=null;this.pendingTimer=null;
    this.retryTimer=null;this.lobbyResolve=null;this.lobbyVersion=-1;this.version=-1;
    this.status='正在连接';this.transport=null;this.hostPeerId=null;this.joined=false;this.lib=null;
    this.seatByPeer=new Map();this.peerBySeat=new Map();this.spectators=new Map();
  }
  setStatus(v){if(this.closed)return;this.status=v;this.onStatus(v);}
  store(){if(!this.closed&&!this.id.spectator)this.save({...this.id,pending:this.pending});}
  accept(snapshot,ack){
    if(this.closed||snapshot.version<this.version)return;
    this.version=snapshot.version;
    const acked=!!ack&&!!this.pending&&ack===this.pending.id;
    this.status=acked||this.pending?'正在确认操作':'已连接';
    this.onSnapshot(snapshot);this.onStatus(this.status);
    if(acked){
      this.cancel(this.retryTimer);this.cancel(this.pendingTimer);
      this.pending=null;this.store();
      if(this.pendingResolve){const r=this.pendingResolve;this.pendingResolve=null;r();}
    }
    if(this.lobbyResolve&&snapshot.version>this.lobbyVersion){const r=this.lobbyResolve;this.lobbyResolve=null;this.cancel(this.lobbyTimer);r.resolve();}
  }

  /* ---------- lifecycle ---------- */
  async start(){
    if(this.closed)return;
    const events={
      onPeerJoin:peerId=>{if(this.isHost&&this.transport)this.transport.sendTo(peerId,{kind:'whoami'});},
      onPeerLeave:peerId=>{
        if(this.isHost){
          const seat=this.seatByPeer.get(peerId);
          if(seat!==undefined&&this.roomState.seats[seat]){this.roomState.seats[seat].online=false;this.roomState.seats[seat].ready=false;}
          this.seatByPeer.delete(peerId);this.peerBySeat.delete(seat);this.spectators.delete(peerId);
          this.saveHostState();this.broadcastSnapshots();
        }else if(peerId===this.hostPeerId){
          this.setStatus('房主已离开');this.onError(Error('房主已离开房间'));
        }
      },
      onMessage:(data,peerId)=>this.handleMessage(data,peerId)
    };
    this.transport=await connectTransport(this.id.room,events);
    this.lib=this.transport.name;
    if(this.isHost){
      this.setStatus('已连接');
      this.accept(snapshot(this.roomState));
      this.saveHostState();
    }else{
      this.setStatus('已连接');
    }
  }
  poll(){
    if(this.closed||this.polling)return;
    this.polling=true;
    try{
      if(this.isHost)this.accept(snapshot(this.roomState));
      else if(this.transport&&this.hostPeerId)this.transport.sendTo(this.hostPeerId,{kind:'state-request'});
    }finally{this.polling=false;}
  }
  close(){
    this.closed=true;
    this.cancel(this.retryTimer);this.cancel(this.pendingTimer);
    try{if(this.transport&&this.transport.leave)this.transport.leave();}catch{}
    this.transport=null;
    if(this.pendingResolve){const r=this.pendingResolve;this.pendingResolve=null;r(Error('连接已关闭'));}
    if(this.lobbyResolve){const r=this.lobbyResolve;this.lobbyResolve=null;r();}
  }

  /* ---------- host persistence ---------- */
  saveHostState(){
    if(!this.isHost)return;
    try{
      const r=this.roomState,value={...r,game:r.game?JSON.parse(r.game.export()):null};
      localStorage.setItem(this.hostStateKey,JSON.stringify(value));
    }catch{}
  }
  static loadHostState(key=HOST_KEY){try{return JSON.parse(localStorage.getItem(key));}catch{return null;}}
  static clearHostState(key=HOST_KEY){try{localStorage.removeItem(key);}catch{}}

  /* ---------- messages ---------- */
  handleMessage(raw,peerId){
    let msg=raw;
    if(typeof msg==='string'){try{msg=JSON.parse(msg);}catch{return;}}
    if(!msg||typeof msg!=='object')return;
    if(this.transport&&peerId===this.transport.selfId)return;
    try{
      if(this.isHost){
        switch(msg.kind){
          case 'join':this.handleGuestJoin(peerId,msg);break;
          case 'command':this.handleGuestCommand(peerId,msg);break;
          case 'lobby':this.handleGuestLobby(peerId,msg);break;
          case 'state-request':{
            const seat=this.seatByPeer.get(peerId);
            if(seat!==undefined)this.transport.sendTo(peerId,{kind:'snapshot',snapshot:snapshot(this.roomState,seat)});
            else if(this.spectators.has(peerId))this.transport.sendTo(peerId,{kind:'snapshot',snapshot:snapshot(this.roomState,null)});
            break;
          }
        }
      }else{
        switch(msg.kind){
          case 'whoami':this.hostPeerId=peerId;this.setStatus('已连接');this.sendJoin();break;
          case 'welcome':this.onWelcome(msg,peerId);break;
          case 'snapshot':this.accept(msg.snapshot,msg.ack);break;
          case 'error':
            if(this.pending){this.cancel(this.retryTimer);this.cancel(this.pendingTimer);this.pending=null;this.store();}
            if(this.pendingResolve){const r=this.pendingResolve;this.pendingResolve=null;r();}
            this.onError(Object.assign(Error(msg.message||'操作失败'),{status:msg.status||400}));
            break;
        }
      }
    }catch(e){this.onError(e);}
  }
  sendJoin(){
    if(this.joined)return;
    this.joined=true;
    this.transport.sendTo(this.hostPeerId,{kind:'join',name:this.id.name||'',seat:this.id.seat,token:this.id.token,spectator:!!this.id.spectator});
  }
  onWelcome(msg,peerId){
    this.hostPeerId=peerId;
    if(msg.error){this.onError(Object.assign(Error(msg.error),{status:403}));return;}
    this.id.seat=msg.seat;this.id.token=msg.token;this.id.name=msg.name||this.id.name;this.id.spectator=!!msg.spectator;
    this.store();
    if(msg.snapshot)this.accept(msg.snapshot);
  }
  handleGuestJoin(peerId,msg){
    const r=this.roomState,now=Date.now();
    if(msg.spectator){
      this.spectators.set(peerId,true);
      this.transport.sendTo(peerId,{kind:'welcome',spectator:true,snapshot:snapshot(r,null)});
      return;
    }
    const name=String(msg.name||'').trim().slice(0,24);
    const seatIn=Number.isInteger(msg.seat)?msg.seat:NaN;
    let seat=null;
    if(msg.token&&seatIn>=0&&r.seats[seatIn]&&r.seats[seatIn].token===msg.token){
      seat=seatIn;r.seats[seat].name=name||r.seats[seat].name;r.seats[seat].online=true;r.seats[seat].seen=now;
    }else{
      const free=r.seats.find(s=>!s.online);
      if(!free){this.transport.sendTo(peerId,{kind:'error',message:'房间已满',status:403});return;}
      seat=free.seat;r.seats[seat].name=name||('玩家'+(seat+1));r.seats[seat].online=true;r.seats[seat].seen=now;
    }
    this.seatByPeer.set(peerId,seat);this.peerBySeat.set(seat,peerId);
    this.transport.sendTo(peerId,{kind:'welcome',seat,token:r.seats[seat].token,name:r.seats[seat].name,snapshot:snapshot(r,seat)});
    this.saveHostState();this.broadcastSnapshots();
  }
  handleGuestCommand(peerId,msg){
    const seat=this.seatByPeer.get(peerId);
    if(seat===undefined){this.transport.sendTo(peerId,{kind:'error',message:'请先加入房间',status:403});return;}
    try{this.executeCommand(seat,msg);}
    catch(e){this.transport.sendTo(peerId,{kind:'error',message:e.message,status:e.status||400});}
  }
  handleGuestLobby(peerId,msg){
    const seat=this.seatByPeer.get(peerId);
    if(seat===undefined){this.transport.sendTo(peerId,{kind:'error',message:'请先加入房间',status:403});return;}
    const r=this.roomState;
    try{
      if(msg.op==='ready'){r.seats[seat].ready=!!msg.args.ready;r.version++;this.broadcastSnapshots();}
      else if(msg.op==='preferences'){
        r.seats[seat].pauseDice=msg.args.pauseDice!==false;
        if(msg.args.pausePurchase!==undefined)r.seats[seat].pausePurchase=!!msg.args.pausePurchase;
        r.version++;this.broadcastSnapshots();
      }
      else throw Object.assign(Error('接口不存在'),{status:404});
    }catch(e){this.transport.sendTo(peerId,{kind:'error',message:e.message,status:e.status||400});}
  }

  /* ---------- host authority ---------- */
  executeCommand(seat,msg){
    const r=this.roomState,g=r.game;
    if(!g)throw Object.assign(Error('对局尚未开始'),{status:400});
    if(typeof msg.id!=='string'||!/^[\w-]{8,80}$/.test(msg.id))throw Object.assign(Error('操作编号无效'),{status:400});
    const signature=digest(JSON.stringify({type:msg.type,args:msg.args,revision:msg.revision}));
    const prior=r.receipts.find(x=>x.id===msg.id&&x.seat===seat);
    if(prior){if(prior.signature!==signature)throw Object.assign(Error('操作编号已使用'),{status:409});this.broadcastSnapshots(seat,msg.id);return;}
    if(msg.revision!==g.s.revision)throw Object.assign(Error('桌面已有更新，请重试当前操作'),{status:409});
    if(!msg.args||Array.isArray(msg.args)||typeof msg.args!=='object')throw Object.assign(Error('操作参数错误'),{status:400});
    Flow.command(g,seat,msg.type,msg.args);
    Flow.advance(g,{pauseDice:r.seats[g.s.active]?r.seats[g.s.active].pauseDice!==false:true,pausePurchase:r.seats[g.s.active]?r.seats[g.s.active].pausePurchase!==false:true});
    r.receipts.push({id:msg.id,seat,signature});if(r.receipts.length>1000)r.receipts.shift();
    r.version++;
    this.observeMetrics();
    this.saveHostState();
    this.broadcastSnapshots(seat,msg.id);
  }
  observeMetrics(){
    const r=this.roomState;
    if(r.game&&root.TabletopTesting)r.metrics=root.TabletopTesting.observe(r.metrics,r.game.view(),r.startedAt);
  }
  broadcastSnapshots(ackSeat=null,ackId=null){
    const r=this.roomState;
    for(const [peerId,seat] of this.seatByPeer){
      this.transport.sendTo(peerId,{kind:'snapshot',snapshot:snapshot(r,seat),...(seat===ackSeat?{ack:ackId}:{})});
    }
    for(const peerId of this.spectators.keys()){
      this.transport.sendTo(peerId,{kind:'snapshot',snapshot:snapshot(r,null)});
    }
    this.accept(snapshot(r, this.id.seat), this.id.seat===ackSeat?ackId:null);
  }

  /* ---------- command / lobby (controller-facing) ---------- */
  async command(type,args,revision){
    if(this.closed)throw Error('房间连接已关闭');
    if(this.id.spectator)throw Error('观战者不能操作');
    if(this.pending||this.busy)throw Error('上一项操作仍在确认');
    if(this.status!=='已连接')throw Error('正在重新连接，请等待同步完成');
    const id=randToken();
    this.pending={room:this.id.room,type,args,revision,id};
    this.store();
    if(this.isHost){
      this.busy=true;
      try{this.executeCommand(this.id.seat,this.pending);this.pending=null;}
      finally{this.busy=false;}
      return;
    }
    if(!this.transport||!this.hostPeerId)throw Error('尚未连接房主');
    return new Promise((resolve,reject)=>{
      this.pendingResolve=resolve;
      this.sendCommand();
      this.cancel(this.pendingTimer);
      this.pendingTimer=this.schedule(()=>{
        if(this.pendingResolve&&!this.closed){
          const r=this.pendingResolve;this.pendingResolve=null;
          this.setStatus('操作结果待确认，正在重连；请勿重复提交');
          r();
        }
      },15000);
    });
  }
  sendCommand(){
    if(!this.transport||!this.hostPeerId||!this.pending)return;
    const p=this.pending;
    this.transport.sendTo(this.hostPeerId,{kind:'command',id:p.id,type:p.type,args:p.args,revision:p.revision,seat:this.id.seat,token:this.id.token});
    this.cancel(this.retryTimer);
    this.retryTimer=this.schedule(()=>{if(this.pending&&!this.closed)this.sendCommand();},4000);
  }
  async lobby(route,args={}){
    if(this.closed)throw Error('房间连接已关闭');
    if(this.busy||this.pending)throw Error('正在提交上一项操作');
    if(this.isHost){
      this.busy=true;
      try{this.hostLobby(route,args);}
      finally{this.busy=false;}
      return;
    }
    if(!this.transport||!this.hostPeerId)throw Error('尚未连接房主');
    this.busy=true;
    const before=this.version;
    this.lobbyVersion=before;
    this.transport.sendTo(this.hostPeerId,{kind:'lobby',op:route,args});
    await new Promise(resolve=>{
      const entry={resolve:()=>{this.busy=false;resolve();}};
      this.lobbyResolve=entry;
      if(this.version>before){entry.resolve();return;}
      this.lobbyTimer=this.schedule(()=>{if(this.lobbyResolve===entry){this.lobbyResolve=null;this.busy=false;resolve();}},10000);
    });
  }
  hostLobby(route,args){
    const r=this.roomState;
    const fail=(m,status=400)=>{throw Object.assign(Error(m),{status});};
    switch(route){
      case 'ready':r.seats[this.id.seat].ready=!!args.ready;r.version++;this.broadcastSnapshots();break;
      case 'preferences':
        r.seats[this.id.seat].pauseDice=args.pauseDice!==false;
        if(args.pausePurchase!==undefined)r.seats[this.id.seat].pausePurchase=!!args.pausePurchase;
        r.version++;this.broadcastSnapshots();break;
      case 'start':this.hostStart();break;
      case 'mode':{
        if(this.id.seat!==0)fail('仅房主可切换模式',403);if(r.game)fail('已开局，不能切换模式');
        if(args.version!==(r.rulesVersion||0))fail('房间规则已有更新，请重试',409);
        const legend=args.legend===undefined?!!r.legend:args.legend;
        if(legend&&(args.experimental||(args.quick===undefined?r.quick:args.quick)))fail('一战封神不能与疾速或实验规则叠加');
        if(legend&&(args.quick||args.experimental))fail('一战封神不能与疾速或实验规则叠加');
        r.experimental=!!args.experimental;r.legend=legend;if(args.quick!==undefined)r.quick=!!args.quick;
        r.rules=legend?GameConfig.legendRules():r.experimental?GameConfig.defaults():GameConfig.defaults();
        r.rulesVersion++;r.seats.forEach(s=>s.ready=false);r.version++;this.broadcastSnapshots();break;
      }
      case 'rules':{
        if(this.id.seat!==0)fail('仅房主可修改实验规则',403);if(r.game)fail('已开局，实验规则不能中途修改');if(!r.experimental)fail('请先勾选启用实验性模式');
        if(args.version!==(r.rulesVersion||0))fail('房间规则已有更新，请重新打开实验设置',409);
        r.rules=GameConfig.normalize(args.rules,this.data,r.capacity);r.rulesVersion++;r.seats.forEach(s=>s.ready=false);r.version++;this.broadcastSnapshots();break;
      }
      case 'rename':{
        if(this.id.seat!==0)fail('仅房主可修改房间名称',403);
        const n=String(args.roomName||r.roomName).trim().slice(0,40);if(!n)fail('房间名需要1至40个字符');
        r.roomName=n;if(args.listed!==undefined)r.listed=!!args.listed;if(args.allowSpectators!==undefined)r.allowSpectators=!!args.allowSpectators;
        r.version++;this.broadcastSnapshots();break;
      }
      default:fail('接口不存在',404);
    }
  }
  hostStart(){
    const r=this.roomState;
    if(r.game)throw Error('本局已经开始');
    if(r.seats.length!==r.capacity||r.seats.some(s=>!s.ready||Date.now()-s.seen>=15000))throw Error('请等待所有玩家到齐、在线并准备');
    const g=new HistoryGame(this.data);
    g.newGame(r.seats.map(s=>s.name),Date.now()>>>0,r.experimental?r.rules:GameConfig.defaults(),{quick:!!r.quick,legend:!!r.legend});
    g.s.experimental=!!r.experimental;
    g.s.historyId='p2p-'+r.id;
    r.game=g;r.startedAt=new Date().toISOString();
    Flow.advance(g,{pauseDice:true,pausePurchase:true});
    r.version++;
    this.observeMetrics();
    this.saveHostState();
    this.broadcastSnapshots();
  }
}

const api={TabletopP2PConnection,createRoomState,snapshot,randCode,randToken,connectTransport,clone,digest,HOST_KEY,loadHostState:TabletopP2PConnection.loadHostState,clearHostState:TabletopP2PConnection.clearHostState};
if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.TabletopP2P=api;
})(typeof window==='undefined'?globalThis:window);