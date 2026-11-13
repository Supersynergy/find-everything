import {spawn, type ChildProcess} from 'node:child_process';
import path from 'node:path';
import {startLive} from './live';
import {validateName} from './catalog';
declare const Bun:{main:string};

/** One parent-owned watcher process; reuse the existing process-group guardian. */
export function startLiveProcess(names?:string[],onFailure:()=>void=()=>{}):Promise<()=>void>{
  const source=Bun.main.includes('$bunfs')?[]:[path.join(__dirname,'cli.ts')];
  return new Promise((resolve,reject)=>{
    let stopped=false,ready=false,buffer='',guardian:ChildProcess|undefined;
    const child=spawn(process.execPath,[...source,'_live-worker',JSON.stringify(names??null)],{
      detached:process.platform!=='win32',stdio:['pipe','pipe','pipe'],
      env:{...process.env,FE_LIVE_WORKER:'1',FE_LIVE_OWNER_PID:String(process.pid)}
    });
    const stop=()=>{
      if(stopped)return;stopped=true;clearTimeout(timeout);process.removeListener('exit',stop);
      if(child.pid&&child.exitCode===null&&child.signalCode===null){
        try{if(process.platform==='win32')child.kill('SIGKILL');else process.kill(-child.pid,'SIGKILL');}
        catch(e){if((e as NodeJS.ErrnoException).code!=='ESRCH')child.kill('SIGKILL');}
        guardian?.stdin?.end('complete\n');
      }else guardian?.stdin?.end();
      child.stdin?.destroy();
    };
    const fail=(error:Error)=>{if(!ready)reject(error);else console.error('fe: live worker stopped: '+error.message);stop();if(ready)onFailure();};
    const timeout=setTimeout(()=>fail(new Error('Live worker startup exceeded 10 seconds')),10000);
    process.once('exit',stop);
    child.once('error',fail);
    child.once('spawn',()=>{
      if(process.platform==='win32'||!child.pid)return;
      guardian=spawn(process.execPath,[...source,'_index-guardian',String(child.pid)],{stdio:['pipe','ignore','inherit']});
      guardian.once('error',fail);
      guardian.stdin?.on('error',()=>{});
    });
    child.stdin?.on('error',()=>{});
    child.stderr?.on('data',data=>process.stderr.write(data));
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data',data=>{
      buffer+=data;
      if(buffer.length>4096){fail(new Error('Live worker response exceeds limit'));return;}
      if(!ready&&buffer.includes('\n')){
        try{const message=JSON.parse(buffer.slice(0,buffer.indexOf('\n'))) as {ready?:boolean};if(message.ready!==true)throw new Error('Live worker did not become ready');}
        catch(e){fail(e as Error);return;}
        ready=true;clearTimeout(timeout);resolve(stop);buffer='';
      }
    });
    child.once('exit',(code,signal)=>{if(!stopped)fail(new Error('exit '+String(code??signal)));});
  });
}

export async function serveLiveWorker(value:unknown):Promise<void>{
  if(process.env.FE_LIVE_WORKER!=='1'||Number(process.env.FE_LIVE_OWNER_PID)!==process.ppid)throw new Error('Live worker requires its owning service');
  if(value!==null&&(!Array.isArray(value)||value.length>64||!value.every(n=>typeof n==='string')))throw new Error('Invalid live scopes');
  const names=value===null?undefined:(value as string[]).map(validateName);
  // Only the search reader writes its accelerator; the watcher owns the journal.
  const stop=await startLive(names,300,()=>false),owner=process.ppid;
  process.once('exit',stop);
  process.stdin.once('end',()=>{stop();process.exit(0);});process.stdin.resume();
  const timer=setInterval(()=>{try{if(process.ppid!==owner)throw new Error('Owner exited');process.kill(owner,0);}catch{stop();process.exit(0);}},1000);
  timer.unref();process.once('exit',()=>clearInterval(timer));
  process.stdout.write(JSON.stringify({ready:true})+'\n');
}
