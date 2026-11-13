import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {Database} from 'bun:sqlite';

const phase=process.argv[2];
const root=path.resolve(process.env.FE_BENCH_DIR||'/Users/master/BASE/data/fe-instantfind-20261113/benchmark');
const corpusRoot=path.join(root,'corpus'),index='instantfind-bench';
process.env.FE_DATA_DIR=path.join(root,'cache');process.env.FE_CONFIG_DIR=path.join(root,'config');
process.env.FE_INSTANTFIND_RUNTIME=path.join(root,'runtime');process.env.FE_FAVORITES_FILE=path.join(root,'favorites.json');
process.env.FE_INSTANTFIND_WORKER=path.resolve('runtime/instantfind/worker.py');
fs.mkdirSync(process.env.FE_DATA_DIR,{recursive:true,mode:0o700});
interface Document {path:string;text:string}
interface Case {id:string;language:'de'|'en';path:string;query:string}
interface Row extends Case {ranked:string[];ms:number;error?:string}
const docs=JSON.parse(fs.readFileSync('tests/fixtures/instantfind/corpus.json','utf8')) as Document[];
const cases=JSON.parse(fs.readFileSync('tests/fixtures/instantfind/queries.json','utf8')) as Case[];
const {indexPathFor}=await import('../src/engine');
const {saveProfile}=await import('../src/catalog');
const {indexContents,contentPath}=await import('../src/content-search');
const {prepareSearch}=await import('../src/path-search');
const {indexMeaning}=await import('../src/instantfind');
const {setupInstantRuntime,instantEncoder}=await import('../src/instantfind-worker');
const {searchFiles}=await import('../src/services');
const write=(name:string,value:unknown)=>fs.writeFileSync(path.join(root,name+'.json'),JSON.stringify(value,null,2));
const hash=(name:string)=>createHash('sha256').update(fs.readFileSync(name)).digest('hex');
function summarize(rows:Row[]){
  const times=rows.map(r=>r.ms).sort((a,b)=>a-b),n=rows.length;
  return {n,...Object.fromEntries([1,3,20].map(k=>['top'+k,rows.filter(r=>r.ranked.slice(0,k).includes(r.path)).length])),
    mrr:rows.reduce((sum,r)=>{const rank=r.ranked.indexOf(r.path);return sum+(rank<0?0:1/(rank+1));},0)/n,
    medianMs:(times[Math.floor((n-1)/2)]+times[Math.floor(n/2)])/2,p95Ms:times[Math.ceil(.95*n)-1]};
}
const relative=(paths:string[])=>paths.map(p=>path.relative(corpusRoot,p));
try {
  if(phase==='prepare'){
    if(fs.existsSync(path.join(root,'frozen.json')))throw new Error('Benchmark already prepared; preserve completed evidence');
    for(const doc of docs){const file=path.join(corpusRoot,doc.path);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,doc.text);}
    saveProfile({name:index,paths:[corpusRoot],includeHidden:false,includeIgnored:false},true);
    fs.writeFileSync(indexPathFor(index),docs.map(d=>path.join(corpusRoot,d.path)).join('\n')+'\n',{mode:0o600});
    write('frozen',{at:new Date().toISOString(),corpus:hash('tests/fixtures/instantfind/corpus.json'),queries:hash('tests/fixtures/instantfind/queries.json'),documents:docs.length,queriesCount:cases.length,training:false});
    const paths=await prepareSearch(index,30,100000);
    const content=await indexContents(index,100,60);
    const runtime=await setupInstantRuntime(process.env.FE_BENCH_MODEL||'/Users/master/BASE/data/skill-retrieval-v5-20261113/models/embeddinggemma',process.env.FE_BENCH_PYTHON||'/Users/master/.venvs/synapse/bin/python');
    const semantic=await indexMeaning(index,100,120);
    write('preparation',{paths,content,runtime,semantic});console.log(JSON.stringify({phase,documents:docs.length,chunks:semantic.chunks}));
  }else if(phase==='baseline'){
    if(fs.existsSync(path.join(root,'baseline.json')))throw new Error('Baseline already measured');
    const db=new Database(contentPath(index),{readonly:true});
    const methods:Record<string,Row[]>={paths:[],literalContent:[],ftsWords:[]};let parentPeak=0;
    const stop=new Set('the a an how do i to is in of for with and or can my our die der das ein eine wie ich wir den dem und oder mit von im zum zur für'.split(' '));
    for(const row of cases){
      let start=performance.now();
      try {const exact=await searchFiles(row.query,index,20,{},false,true);methods.paths.push({...row,ranked:relative(exact.paths),ms:performance.now()-start});}
      catch(error){methods.paths.push({...row,ranked:[],ms:performance.now()-start,error:String((error as Error).message)});}
      start=performance.now();const literal=await searchFiles('content:'+JSON.stringify(row.query),index,20,{},false,true);methods.literalContent.push({...row,ranked:relative(literal.paths),ms:performance.now()-start});
      const words=[...new Set(row.query.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu)||[])].filter(t=>!stop.has(t));
      start=performance.now();const hits=words.length?db.query('SELECT path FROM bodies WHERE bodies MATCH ? ORDER BY bm25(bodies),path LIMIT 20').all(words.map(w=>'"'+w.replaceAll('"','""')+'"').join(' OR ')) as {path:string}[]:[];
      methods.ftsWords.push({...row,ranked:relative(hits.map(h=>h.path)),ms:performance.now()-start});
      parentPeak=Math.max(parentPeak,process.memoryUsage().rss/1048576);
    }
    const controls=[];for(const doc of docs.slice(0,10)){const q=path.basename(doc.path);const result=await searchFiles(q,index,20,{},false,true);controls.push({query:q,expected:doc.path,ranked:relative(result.paths)});}
    db.close();const result={methods,summaries:Object.fromEntries(Object.entries(methods).map(([name,rows])=>[name,{all:summarize(rows),de:summarize(rows.filter(r=>r.language==='de')),en:summarize(rows.filter(r=>r.language==='en'))}])),controls,parentPeakMiB:parentPeak};
    write('baseline',result);console.log(JSON.stringify({phase,summaries:result.summaries,parentPeakMiB:parentPeak}));
  }else if(phase==='meaning'){
    if(fs.existsSync(path.join(root,'meaning.json')))throw new Error('Meaning search already measured');
    const start=performance.now();const cold=await searchFiles('meaning:"Find instructions about restoring an application version"',index,20,{},false,true);const coldMs=performance.now()-start;
    const rows:Row[]=[];let parentPeak=process.memoryUsage().rss/1048576,workerPeak=Number(cold.runtime?.peakRssMiB||0),workerPid=Number(cold.runtime?.pid);
    for(const row of cases){const t=performance.now();const result=await searchFiles('meaning:'+JSON.stringify(row.query),index,20,{},false,true);rows.push({...row,ranked:relative(result.paths),ms:performance.now()-t});parentPeak=Math.max(parentPeak,process.memoryUsage().rss/1048576);workerPeak=Math.max(workerPeak,Number(result.runtime?.peakRssMiB||0));}
    const controls=[];for(const doc of docs.slice(0,10)){const q=path.basename(doc.path);const result=await searchFiles('meaning:'+JSON.stringify(q),index,20,{},false,true);controls.push({query:q,expected:doc.path,ranked:relative(result.paths)});}
    await new Promise(resolve=>setTimeout(resolve,10000));const idleStart=performance.now();const idle=await searchFiles('meaning:"Locate guidance on recurring meetings and seasonal clock changes"',index,20,{},false,true);const afterTenSecondsIdleMs=performance.now()-idleStart;
    const result={rows,summaries:{all:summarize(rows),de:summarize(rows.filter(r=>r.language==='de')),en:summarize(rows.filter(r=>r.language==='en'))},controls,coldMs,afterTenSecondsIdleMs,sameWorkerAfterIdle:Number(idle.runtime?.pid)===workerPid,parentPeakMiB:parentPeak,workerPeakMiB:workerPeak,totalPeakUpperMiB:parentPeak+workerPeak,modelSetupMs:cold.runtime?.setupMs};
    write('meaning',result);console.log(JSON.stringify({...result,rows:undefined,controls:undefined}));
  }else throw new Error('Use prepare, baseline or meaning');
}finally{instantEncoder.close();}
