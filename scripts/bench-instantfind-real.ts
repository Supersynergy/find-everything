import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {Database} from 'bun:sqlite';
const root=process.env.FE_REAL_BENCH||'/Users/master/BASE/data/fe-instantfind-real-20261113';
const phase=process.argv[2];
process.env.FE_DATA_DIR=path.join(root,'cache');process.env.FE_CONFIG_DIR=path.join(root,'config');
process.env.FE_INSTANTFIND_RUNTIME=path.join(root,'runtime');process.env.FE_LEARNING_FILE=path.join(root,'learning.json');process.env.FE_FAVORITES_FILE=path.join(root,'pins.json');
const frozen=JSON.parse(fs.readFileSync(path.join(root,'frozen-real.json'),'utf8')) as {files:{path:string;sha256:string}[];cases:{id:string;language:string;path:string;query:string}[]};
for(const f of frozen.files)if(createHash('sha256').update(fs.readFileSync(f.path)).digest('hex')!==f.sha256)throw new Error('Real corpus changed: '+f.path);
const {indexPathFor}=await import('../src/engine');
const {saveProfile}=await import('../src/catalog');
const {indexContents,contentPath}=await import('../src/content-search');
const {indexMeaning}=await import('../src/instantfind');
const {searchFiles}=await import('../src/services');
const {instantEncoder}=await import('../src/instantfind-worker');
const {prepareSearch}=await import('../src/path-search');
const index='real-documents';
const write=(n:string,v:unknown)=>{const file=path.join(root,n+'.json');if(fs.existsSync(file))throw new Error('Evidence already exists: '+file);fs.writeFileSync(file,JSON.stringify(v,null,2));};
function summary(rows:any[]){const ts=rows.map(r=>r.ms).sort((a,b)=>a-b);return {n:rows.length,...Object.fromEntries([1,3,20].map(k=>['top'+k,rows.filter(r=>r.paths.slice(0,k).includes(r.path)).length])),medianMs:(ts[Math.floor((ts.length-1)/2)]+ts[Math.floor(ts.length/2)])/2,p95Ms:ts[Math.ceil(ts.length*.95)-1]};}
try{
 if(phase==='prepare'){
  fs.mkdirSync(process.env.FE_DATA_DIR,{recursive:true});fs.mkdirSync(process.env.FE_INSTANTFIND_RUNTIME,{recursive:true});
  fs.copyFileSync('/Users/master/Library/Application Support/FindEverything/instantfind/config.json',path.join(process.env.FE_INSTANTFIND_RUNTIME,'config.json'));fs.chmodSync(path.join(process.env.FE_INSTANTFIND_RUNTIME,'config.json'),0o600);
  saveProfile({name:index,paths:['/Users/master/BASE/projects/find-everything','/Users/master/BASE/projects/superskills/docs'],includeHidden:false},true);
  fs.writeFileSync(indexPathFor(index),frozen.files.map(f=>f.path).join('\n')+'\n',{mode:0o600});
  const paths=await prepareSearch(index,30,100000),content=await indexContents(index,100,60),meaning=await indexMeaning(index,100,240);
  write('preparation',{paths,content,meaning});console.log(JSON.stringify({phase,content,meaning}));
 }else if(['original','candidate','lexical'].includes(phase)){
  const rows:any[]=[],db=phase==='lexical'?new Database(contentPath(index),{readonly:true}):undefined;let peak=0,workerPeak=0;const stop=new Set('the a an how do i to is in of for with and or can my our die der das ein eine wie ich wir den dem und oder mit von im zum zur für wo wird werden welcher welche welches an als aus bei'.split(' '));
  const coldStart=performance.now();const cold=phase==='lexical'?null:await searchFiles('meaning:"Find guidance about saved file indexes and their operation"',index,20,{},false,true);const coldMs=performance.now()-coldStart;
  for(const row of frozen.cases){const t=performance.now();let result:any;
   if(db){const words=[...new Set(row.query.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu)||[])].filter(w=>!stop.has(w));result={paths:db.query('SELECT path FROM bodies WHERE bodies MATCH ? ORDER BY bm25(bodies),path LIMIT 20').all(words.map(w=>'"'+w+'"').join(' OR ')).map((r:any)=>r.path)};}
   else result=await searchFiles('meaning:'+JSON.stringify(row.query),index,20,{},false,true);
   rows.push({...row,paths:result.paths,ms:performance.now()-t});peak=Math.max(peak,process.memoryUsage().rss/1048576);workerPeak=Math.max(workerPeak,result.runtime?.peakRssMiB||0);
  }
  db?.close();const result={phase,rows,summary:{all:summary(rows),de:summary(rows.filter(r=>r.language==='de')),en:summary(rows.filter(r=>r.language==='en'))},coldMs,parentPeakMiB:peak,workerPeakMiB:workerPeak,totalPeakUpperMiB:peak+workerPeak,modelSetupMs:cold?.runtime?.setupMs};write(phase,result);console.log(JSON.stringify({...result,rows:undefined}));
 }else throw new Error('Use prepare|original|candidate|lexical');
}finally{instantEncoder.close();}
