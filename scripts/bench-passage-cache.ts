import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';import {execFileSync} from 'node:child_process';
const [mode,sourceArg,fixtureArg,outArg]=process.argv.slice(2),source=path.resolve(sourceArg),fixture=path.resolve(fixtureArg);
const hash=(p:string)=>createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const casesFile=path.join(fixture,'cases-passages-frozen.json');
if(mode==='run'||mode==='replay'){
  process.env.FE_DATA_DIR=path.join(fixture,'cache');process.env.FE_CONFIG_DIR=path.join(fixture,'config');
  process.env.FE_INSTANTFIND_WORKER=path.resolve('runtime/instantfind/worker.py');
  process.env.FE_FAVORITES_FILE=path.join(fixture,'pins.json');process.env.FE_LEARNING_FILE=path.join(fixture,'learning.json');
  const {parseQuery}=await import(path.join(source,'src/engine.ts')),{searchMeaning}=await import(path.join(source,'src/instantfind.ts')),{instantEncoder}=await import(path.join(source,'src/instantfind-worker.ts'));
  const all=JSON.parse(fs.readFileSync(casesFile,'utf8')).heldout as {id:string;query:string;filter:string}[],cases=mode==='run'?all.slice(0,8):all;
  const corpus=JSON.parse(fs.readFileSync(path.join(fixture,'corpus.json'),'utf8'));
  const metadata=()=>createHash('sha256').update(JSON.stringify(corpus.files.map((r:{path:string})=>{try{const s=fs.statSync(r.path);return [r.path,s.ino,s.size,s.mtimeMs,s.ctimeMs];}catch{return [r.path,null];}}))).digest('hex');
  const before=metadata(),rows:any[]=[];let parentPeak=0,workerPeak=0;
  try{
    for(const item of cases)for(const offset of [0,10]){
      const start=performance.now(),r=await searchMeaning('large-real',parseQuery('meaning:'+JSON.stringify(item.query)+' '+item.filter),10,offset);
      assert(r.instantfind&&Array.isArray(r.scores),'Meaning index must be prepared');
      const signature=createHash('sha256').update(JSON.stringify([r.paths,r.scores,r.snippets,r.properties,r.coverage,r.nextOffset,r.snapshotId])).digest('hex');
      rows.push({id:item.id,offset,ms:performance.now()-start,signature,refined:r.runtime.refinedPassages,hits:r.runtime.passageCacheHits??0,encoded:r.runtime.encodedPassages??r.runtime.refinedPassages});
      parentPeak=Math.max(parentPeak,process.resourceUsage().maxRSS/1024);workerPeak=Math.max(workerPeak,r.runtime.peakRssMiB);
    }
    assert.equal(metadata(),before,'Source metadata changed during measurement');
    const median=(values:number[])=>{const s=values.slice().sort((a,b)=>a-b);return (s[Math.floor((s.length-1)/2)]+s[Math.floor(s.length/2)])/2;};
    console.log(JSON.stringify({passed:true,cases:cases.length,casesHash:hash(casesFile),corpusHash:hash(path.join(fixture,'corpus.json')),sourceMetadata:before,firstPageMedianMs:median(rows.filter(r=>!r.offset).map(r=>r.ms)),nextPageMedianMs:median(rows.filter(r=>r.offset).map(r=>r.ms)),parentPeakMiB:parentPeak,workerPeakMiB:workerPeak,totalPeakUpperMiB:parentPeak+workerPeak,encoded:rows.reduce((n,r)=>n+r.encoded,0),hits:rows.reduce((n,r)=>n+r.hits,0),rows}));
  }finally{instantEncoder.close();}
}else if(mode==='compare'){
  const out=path.resolve(outArg);fs.mkdirSync(out,{recursive:true,mode:0o700});
  assert(!fs.existsSync(path.join(out,'summary.json')),'Preserve previous results');
  const candidate=process.cwd(),script=path.resolve(import.meta.path),environment={...process.env};delete environment.FE_PASSAGE_CACHE;
  fs.writeFileSync(path.join(out,'plan.json'),JSON.stringify({baseline:source,candidate,fixture,casesHash:hash(casesFile),knownReplay:true,pages:[0,10],hyperfineCases:'first eight frozen cases',warmups:1,runs:3},null,2));
  const replay=(root:string)=>JSON.parse(execFileSync(process.execPath,[script,'replay',root,fixture],{encoding:'utf8',env:environment,timeout:240000,maxBuffer:4*1024**2}));
  const before=replay(source),after=replay(candidate);
  fs.writeFileSync(path.join(out,'replay.json'),JSON.stringify({before,after},null,2));
  assert.equal(before.sourceMetadata,after.sourceMetadata);assert.equal(before.casesHash,after.casesHash);assert.equal(before.corpusHash,after.corpusHash);
  assert.deepEqual(after.rows.map((r:any)=>[r.id,r.offset,r.signature]),before.rows.map((r:any)=>[r.id,r.offset,r.signature]));assert(after.hits>0);assert(after.encoded<before.encoded);
  const quote=(s:string)=>"'"+s.replaceAll("'","'\\''")+"'",command=(root:string)=>[process.execPath,script,'run',root,fixture].map(quote).join(' ');
  execFileSync('hyperfine',['--warmup','1','--runs','3','--metrics','time','--export-json',path.join(out,'hyperfine.json'),'--command-name','0.3.42',command(source),'--command-name','0.3.43',command(candidate)],{env:environment,stdio:'inherit',timeout:240000});
  const times=JSON.parse(fs.readFileSync(path.join(out,'hyperfine.json'),'utf8'));
  const summary={passed:true,knownReplay:true,cases:before.cases,pagesPerCase:2,casesHash:before.casesHash,corpusHash:before.corpusHash,identicalResults:true,before:{nextPageMedianMs:before.nextPageMedianMs,firstPageMedianMs:before.firstPageMedianMs,totalPeakUpperMiB:before.totalPeakUpperMiB,encoded:before.encoded},after:{nextPageMedianMs:after.nextPageMedianMs,firstPageMedianMs:after.firstPageMedianMs,totalPeakUpperMiB:after.totalPeakUpperMiB,encoded:after.encoded,hits:after.hits},hyperfine:times,limits:['Known 40-question replay; not another blind evaluation','Same prepared 497-document corpus, model and vectors','Hyperfine includes startup and eight two-page queries per command','Native UI and API response caching are not measured','Memory is summed process peaks; cache payload is bounded separately']};
  fs.writeFileSync(path.join(out,'summary.json'),JSON.stringify(summary,null,2));console.log(JSON.stringify({...summary,hyperfine:undefined}));
}else throw new Error('Usage: run|replay SOURCE FIXTURE | compare BASELINE_SOURCE FIXTURE OUTPUT');
