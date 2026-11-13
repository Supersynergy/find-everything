import {test} from 'bun:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
test('real worker protocol keeps kind, model identity, lifecycle and failure boundaries',async()=>{
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'fe-passage-')));process.env.FE_INSTANTFIND_RUNTIME=root;
  const model=path.join(root,'model'),python=path.join(root,'python'),helper=path.join(root,'worker.py'),calls=path.join(root,'calls');fs.mkdirSync(path.join(model,'onnx'),{recursive:true});
  const files={'config.json':1,'tokenizer.json':1,'onnx/model_q4.onnx':1,'onnx/model_q4.onnx_data':1};for(const f of Object.keys(files))fs.writeFileSync(path.join(model,f),'x');
  fs.writeFileSync(helper,'# initial');process.env.FE_INSTANTFIND_WORKER=helper;
  fs.writeFileSync(python,`#!${process.execPath}\nimport fs from 'node:fs';import readline from 'node:readline';for await(const line of readline.createInterface({input:process.stdin})){const q=JSON.parse(line);fs.appendFileSync(${JSON.stringify(calls)},q.kind+'\\n');if(q.texts[0]==='fail'){console.log(JSON.stringify({id:q.id,error:'fixture failure'}));continue;}console.log(JSON.stringify({id:q.id,vectors:q.texts.map(t=>Array.from({length:768},(_,i)=>i===0?(q.kind==='passage'?0.25:0.75):0)),pid:process.pid,setupMs:1,peakRssMiB:1}));}\n`,{mode:0o700});
  const {InstantFindWorker,INSTANT_MODEL}=await import('../../../src/instantfind-worker');
  fs.writeFileSync(path.join(root,'config.json'),JSON.stringify({modelId:INSTANT_MODEL,model,python,files}),{mode:0o600});
  const worker=new InstantFindWorker();
  const n=()=>fs.readFileSync(calls,'utf8').trim().split('\n').length;
  try{
    const first=await worker.encode(['same text'],'passage'),again=await worker.encode(['same text'],'passage');assert.deepEqual(first.vectors,again.vectors);assert.equal(n(),1);assert.equal(worker.cacheStats().hits,1);
    await worker.encode(['same text'],'query');await worker.encode(['same text'],'query');assert.equal(n(),2,'query kind has its own cache');
    await worker.encode(['same text'],'document');await worker.encode(['same text'],'document');assert.equal(n(),4,'document indexing keeps its own existing deduplication');
    fs.appendFileSync(helper,'\n# changed');const fresh=await worker.encode(['same text'],'passage');assert.notEqual(fresh.pid,first.pid);assert.equal(n(),5);
    worker.close();const restarted=await worker.encode(['same text'],'passage');assert.notEqual(restarted.pid,fresh.pid);assert.equal(n(),6);
    await assert.rejects(worker.encode(['fail'],'passage'),/fixture failure/);await assert.rejects(worker.encode(['fail'],'passage'),/fixture failure/);assert.equal(n(),8,'failures must never be cached');
    fs.appendFileSync(path.join(model,'config.json'),'x');await assert.rejects(worker.encode(['same text'],'passage'),/model changed/);
    fs.writeFileSync(path.join(model,'config.json'),'x');fs.appendFileSync(path.join(root,'config.json'),' ');await worker.encode(['same text'],'passage');assert.equal(n(),9);
    process.env.FE_PASSAGE_CACHE='off';const disabled=new InstantFindWorker();try{await disabled.encode(['same text'],'passage');await disabled.encode(['same text'],'passage');assert.equal(n(),11);}finally{disabled.close();}
  }finally{worker.close();fs.rmSync(root,{recursive:true,force:true});}
},15000);
