import assert from 'node:assert/strict';

// Run in the controller container: native replicas and gateway have independent
// PID namespaces. An orphaned CLI must not outlive the cut being measured.
export async function requireIdleHost(probe) {
  const processes = JSON.parse(await probe.node("import{readdir,readFile}from'node:fs/promises';const rows=[];for(const id of (await readdir('/proc')).filter(id=>/^\\d+$/.test(id))){if(Number(id)===process.pid)continue;try{rows.push({pid:Number(id),args:(await readFile('/proc/'+id+'/cmdline','utf8')).split('\\0').slice(0,-1)})}catch(error){if(error.code!=='ENOENT')throw error}}console.log(JSON.stringify(rows));"));
  assert.deepEqual(processes, [{ pid: 1, args: ['/usr/local/bin/node', '/app/qualification/controller.mjs'] }], 'Only the idle qualification host may remain between cases');
  const available = JSON.parse(await probe.node("import{createConnection}from'node:net';const free=await new Promise((resolve,reject)=>{const socket=createConnection({host:'127.0.0.1',port:8083});socket.once('connect',()=>{socket.destroy();resolve(false)});socket.once('error',error=>error.code==='ECONNREFUSED'?resolve(true):reject(error));socket.setTimeout(2000,()=>{socket.destroy();reject(Error('Port check timed out'))})});console.log(JSON.stringify(free));"));
  assert.equal(available, true, 'A previous private controller still owns the gateway lookup port');
}
