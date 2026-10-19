// Executed inside the controller solely by live-ingress.mjs.
import { readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
const [host, room, file] = process.argv.slice(1);
const state = { opens: 0, closes: [], messages: [] };
let stopping=false;
const save = () => { if(stopping)return; writeFileSync(`${file}.tmp`, JSON.stringify(state), {mode:0o600}); renameSync(`${file}.tmp`,file); };
const socket = new WebSocket(`ws://${host}:8080/rooms/${room}`, {headers:{Origin:`http://${host}:8080`}});
socket.addEventListener('open',()=>{state.opens++;save();});
socket.addEventListener('close',e=>{state.closes.push({code:e.code,at:Date.now()});save();});
socket.addEventListener('message',e=>{state.messages.push(JSON.parse(e.data));save();});
socket.addEventListener('error',()=>{state.error=true;save();});
let sent=false;
const interval=setInterval(()=>{
  let command; try {command=readFileSync(`${file}.command`,'utf8');} catch {return;}
  if(command==='stop') { stopping=true; rmSync(file,{force:true}); clearInterval(interval); clearTimeout(deadline); socket.close(); rmSync(`${file}.command`,{force:true}); }
  else if(command==='probe'&&!sent&&socket.readyState===1) {
    sent=true;
    socket.send(JSON.stringify({type:'operation',opId:'control-probe',operation:{kind:'invalid'}}));
  }
},100);
const deadline=setTimeout(()=>{socket.close();clearInterval(interval);process.exitCode=1;},120000);
