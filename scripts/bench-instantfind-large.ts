import fs from 'node:fs';import path from 'node:path';import {createHash}from'node:crypto';import {spawnSync}from'node:child_process';
const root=process.env.FE_LARGE_BENCH||'/Users/master/BASE/data/fe-instantfind-quality-20261113';
process.env.FE_DATA_DIR=root+'/cache';process.env.FE_CONFIG_DIR=root+'/config';process.env.FE_INSTANTFIND_RUNTIME ||='/Users/master/Library/Application Support/FindEverything/instantfind';process.env.FE_INSTANTFIND_WORKER ||= path.resolve('runtime/instantfind/worker.py');process.env.FE_FAVORITES_FILE=root+'/pins.json';process.env.FE_LEARNING_FILE=root+'/learning.json';
const {indexPathFor}=await import('../src/engine');const {saveProfile}=await import('../src/catalog');const {indexContents,contentPath}=await import('../src/content-search');const{Database}=await import('bun:sqlite');
const{indexMeaning}=await import('../src/instantfind');const{instantEncoder}=await import('../src/instantfind-worker');const {prepareSearch}=await import('../src/path-search');
const phase=process.argv[2],index='large-real';
const casesFile=process.env.FE_CASES_FILE||root+'/cases-frozen.json',prefix=process.env.FE_RESULT_PREFIX||'',selectionFile=process.env.FE_SELECTION_FILE||root+'/selection-frozen.json';
const hash=(p:string)=>createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const implementation=()=>{const h=createHash('sha256');for(const p of ['src/instantfind.ts','src/content-search.ts','src/instantfind-worker.ts','runtime/instantfind/worker.py','runtime/instantfind/compact_model.py','runtime/instantfind/compact_tokenizer.py'])h.update(fs.readFileSync(path.resolve(p)));return h.digest('hex');};const corpus=JSON.parse(fs.readFileSync(root+'/corpus.json','utf8')) as {files:{path:string;sha256:string}[]};
function unchanged(){for(const f of corpus.files)if(createHash('sha256').update(fs.readFileSync(f.path)).digest('hex')!==f.sha256)throw new Error('Corpus changed: '+f.path);}
try{
 if(phase==='evaluate'){const checked=spawnSync(process.execPath,[import.meta.path,'validate'],{encoding:'utf8'});if(checked.status!==0)throw new Error(checked.stderr||'Corpus changed');}else unchanged();
 if(phase==='validate'){console.log('Corpus hashes match');}
 else if(phase==='extract'){
  fs.mkdirSync(process.env.FE_DATA_DIR,{recursive:true});saveProfile({name:index,paths:['/Users/master/Documents','/Users/master/Downloads','/Users/master/BASE/projects'],includeHidden:false},true);fs.writeFileSync(indexPathFor(index),corpus.files.map(f=>f.path).join('\n')+'\n',{mode:0o600});await prepareSearch(index,60,100000);
  const result=await indexContents(index,1000,300);fs.writeFileSync(root+'/extraction.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));
  const db=new Database(contentPath(index),{readonly:true});const rows=db.query('SELECT f.path,f.status,length(b.body) AS chars,substr(b.body,1,1800) AS preview FROM files f LEFT JOIN bodies b ON f.path=b.path ORDER BY f.path').all();fs.writeFileSync(root+'/inventory.json',JSON.stringify(rows,null,2));db.close();
 }else if(phase==='index'){
  const result=await indexMeaning(index,1000,300);fs.writeFileSync(root+'/index-progress.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));
 }else if(phase==='evaluate'){
  const method=process.argv[3],split=process.argv[4];if(!['baseline','hybrid-head','topics','passages'].includes(method)||!['development','heldout','regression'].includes(split))throw new Error('Choose method and split');
  const output=root+'/'+prefix+method+'-'+split+'.json';if(fs.existsSync(output))throw new Error('Evaluation exists; preserve prior evidence');
  if(split==='heldout'&&!fs.existsSync(selectionFile))throw new Error('Freeze method selection before opening heldout results');
  const cases=JSON.parse(fs.readFileSync(casesFile,'utf8'))[split==='regression'?'heldout':split] as {id:string;language:string;kind:string;expected:string[];query:string;filter:string}[];
  const baseline=method==='baseline';
  const engine=await import('../src/engine');
  const reference=await import(root+'/baseline-instantfind.ts');
  const search=baseline?reference.searchMeaning:(await import('../src/instantfind')).searchMeaning;
  const coldStart=performance.now();const first=await search(index,engine.parseQuery('meaning:"Find source material about a project and its operating instructions"'),20,0);const coldMs=performance.now()-coldStart;
  const rows:any[]=[];let parentPeak=process.resourceUsage().maxRSS/1024,workerPeak=0;
  for(const row of cases){const t=performance.now();const result=await search(index,engine.parseQuery('meaning:'+JSON.stringify(row.query)+' '+row.filter),split==='development'?1000:20,0);rows.push({...row,paths:result.paths,coverage:result.coverage,ms:performance.now()-t,...(split==='development'?{scores:result.scores,lexical:[]}:{} )});parentPeak=Math.max(parentPeak,process.resourceUsage().maxRSS/1024);workerPeak=Math.max(workerPeak,result.runtime?.peakRssMiB||0);}
  const summary=(rs:typeof rows)=>{const times=rs.map(r=>r.ms).sort((a,b)=>a-b);return {n:rs.length,...Object.fromEntries([1,3,20].map(k=>['top'+k,rs.filter(r=>r.paths.slice(0,k).some((p:string)=>r.expected.includes(p))).length])),medianMs:(times[Math.floor((times.length-1)/2)]+times[Math.floor(times.length/2)])/2,p95Ms:times[Math.ceil(times.length*.95)-1]};};
  const result={method,split,coldMs,modelSetupMs:first.runtime?.setupMs,modelPid:first.runtime?.pid,selectionHash:split==='heldout'?hash(selectionFile):null,implementationHash:baseline?hash(root+'/baseline-instantfind.ts'):implementation(),casesHash:hash(casesFile),corpusHash:hash(root+'/corpus.json'),summary:{all:summary(rows),de:summary(rows.filter(r=>r.language==='de')),en:summary(rows.filter(r=>r.language==='en')),...Object.fromEntries(['pdf','office','text'].map(k=>[k,summary(rows.filter(r=>r.kind===k))]))},parentPeakMiB:parentPeak,workerPeakMiB:workerPeak,totalPeakUpperMiB:parentPeak+workerPeak,rows};
  fs.writeFileSync(output,JSON.stringify(result,null,2));console.log(JSON.stringify({...result,rows:undefined}));
 }else if(phase==='verify-final'){
  const previous=JSON.parse(fs.readFileSync(root+'/final-baseline-heldout.json','utf8')),current=JSON.parse(fs.readFileSync(root+'/integration-passages-regression.json','utf8')),blind=JSON.parse(fs.readFileSync(root+'/final-passages-heldout.json','utf8'));
  if(current.implementationHash!==implementation()||previous.implementationHash!==hash(root+'/baseline-instantfind.ts'))throw new Error('Evaluation code changed');
  for(const result of [previous,current])if(result.casesHash!==hash(root+'/cases-passages-frozen.json')||result.corpusHash!==hash(root+'/corpus.json'))throw new Error('Evaluation inputs changed');
  const a=previous.summary.all,b=current.summary.all;
  if(a.n!==40||b.n!==40||b.top1-a.top1<4||b.top20<a.top20||current.totalPeakUpperMiB>previous.totalPeakUpperMiB)throw new Error('Quality or RAM acceptance failed');
  if(blind.selectionHash!==hash(root+'/selection-passages-frozen.json')||previous.selectionHash!==blind.selectionHash)throw new Error('Frozen selection changed');
  const originalChecks=JSON.parse(fs.readFileSync(root+'/checks-preintegration.json','utf8'));if(blind.implementationHash!==originalChecks.hash||current.summary.all.top1<blind.summary.all.top1)throw new Error('Blind-test evidence or integration regressed');
  const checks=JSON.parse(fs.readFileSync(root+'/checks.json','utf8'));if(checks.hash!==implementation()||checks.result!=='pass')throw new Error('Code checks missing');
  const regression=JSON.parse(fs.readFileSync(root+'/integration-known-passages-regression.json','utf8'));if(regression.implementationHash!==implementation()||regression.summary.all.top1<57||regression.summary.all.top20!==60)throw new Error('Known regression failed');
  const installed='/Users/master/Applications/Find Everything.app/Contents';
  if(hash(installed+'/Helpers/fe')!==hash(path.resolve('app/Find Everything.app/Contents/Helpers/fe')))throw new Error('Installed app was replaced');
  for(const name of ['worker.py','compact_model.py','compact_tokenizer.py'])if(hash(installed+'/Resources/instantfind/'+name)!==hash(path.resolve('runtime/instantfind/'+name)))throw new Error('Installed runtime differs');
  const smoke=JSON.parse(fs.readFileSync(root+'/installed-smoke.json','utf8'));if(!smoke.health.ok||smoke.results.length!==2||smoke.results[0].runtime.pid!==smoke.results[1].runtime.pid)throw new Error('Installed service acceptance missing');
  console.log(JSON.stringify({passed:true,top1Gain:b.top1-a.top1,top20:b.top20,previousPeakMiB:previous.totalPeakUpperMiB,currentPeakMiB:current.totalPeakUpperMiB}));
 }else throw new Error('Use extract|index|evaluate|verify');
}finally{instantEncoder.close();}
