import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';

export async function copyPreviewRuntime(runtime, source, target) {
 const prefix=source.replace('/app/','').replace(/\/\.$/,'/');
 for(const path of Object.keys(runtime.sourceFiles).filter(path=>path===prefix||path.startsWith(prefix))){
  const name=path===prefix?target:join(target,path.slice(prefix.length));await mkdir(dirname(name),{recursive:true,mode:0o700});await writeFile(name,await readFile(path),{mode:0o600});
 }
 return '';
}
export function previewProcessCommand(observed, args) {
 if(args[0]==='exec')return JSON.stringify({ready:true});
 if(args[0]==='wait'){
  const c=observed.containers.find(c=>c.Id===args[1]);Object.assign(c.State,{Status:'exited',Running:false,Pid:0,ExitCode:0});return '0';
 }
 for(const id of args.slice(args[0]==='stop'?3:1)){
  const c=observed.containers.find(c=>c.Id===id);
  Object.assign(c.State,args[0]==='start'?{Status:'running',Running:true,Pid:100,StartedAt:new Date().toISOString()}:{Status:'exited',Running:false,Pid:0,ExitCode:0});
 }
 return '';
}
