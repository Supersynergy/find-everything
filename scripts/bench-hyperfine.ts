import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';

interface Reply {paths:string[];coverage:{matched:number};engine:string;complete:boolean;nextOffset:number|null}
interface HyperfineResult {command:string;mean:number;stddev:number;times:number[];exit_codes:number[]}
interface HyperfineV2 {name:string;summary:{time_wall_clock:{mean:number;stddev:number}};measurements:{time_wall_clock:{value:number};exit_code:number}[]}
const [baselineArg,candidateArg,outputArg]=process.argv.slice(2);
if(!baselineArg||!candidateArg||!outputArg)throw new Error('Usage: bun scripts/bench-hyperfine.ts BASELINE_CLI CANDIDATE_CLI OUTPUT_DIRECTORY');
const baseline=path.resolve(baselineArg),candidate=path.resolve(candidateArg),output=path.resolve(outputArg);
fs.mkdirSync(output,{recursive:true});
const root=path.join(output,'empty-root');fs.mkdirSync(root,{recursive:true});
const rows=200000;
const paths=Array.from({length:rows},(_,i)=>`/Fixture/dept-${String(i%1000).padStart(4,'0')}/${i%17===0?'node_modules/':''}${i%499===0?'needle':'entry'}-${String(i).padStart(7,'0')}.${i%3===0?'pdf':'txt'}`);
const cases=[
  {id:'filename',query:'name:needle ext:pdf sort:name',offset:0},
  {id:'folder',query:'in:/Fixture/dept-0042/ ext:pdf sort:name',offset:0},
  {id:'folder-wide',query:'in:/Fixture/ sort:name',offset:0},
  {id:'broad',query:'entry sort:name',offset:0},
  {id:'deep-page',query:'entry sort:path',offset:150000},
  {id:'exclusion',query:'entry !node_modules ext:pdf sort:name',offset:0},
];
const sha=(data:string|Buffer)=>createHash('sha256').update(data).digest('hex');
const quote=(s:string)=>"'"+s.replaceAll("'","'\\''")+"'";
const binaries={baseline,candidate};
const baselineSha256=sha(fs.readFileSync(baseline)),candidateSha256=sha(fs.readFileSync(candidate));
const summaryFile=path.join(output,'summary.json');
const previous=fs.existsSync(summaryFile)?JSON.parse(fs.readFileSync(summaryFile,'utf8')):null;
const reusable=previous?.passed&&previous.baselineSha256===baselineSha256&&previous.candidateSha256===candidateSha256&&previous.fixtureSha256===sha(paths.join('\n'));
const envFor=(variant:string)=>({...process.env,FE_DATA_DIR:path.join(output,variant),FE_CONFIG_DIR:path.join(output,variant+'-config')});
const run=(variant:keyof typeof binaries,args:string[])=>JSON.parse(execFileSync(binaries[variant],[...args,'--json'],{env:envFor(variant),encoding:'utf8',timeout:60000,maxBuffer:8*1024**2})) as Reply;
const preflight:Record<string,Record<string,unknown>>={};
for(const variant of ['baseline','candidate'] as const){
  if(!fs.existsSync(path.join(envFor(variant).FE_DATA_DIR,'search-bench.sqlite'))){
    run(variant,['index',root,'--name','bench']);
    fs.writeFileSync(path.join(envFor(variant).FE_DATA_DIR,'index-bench.txt'),paths.join('\n')+'\n');
    run(variant,['prepare','--index','bench']);
  }
  preflight[variant]={};
  for(const c of cases){
    if(reusable&&previous.preflight[variant][c.id]){preflight[variant][c.id]=previous.preflight[variant][c.id];continue;}
    const result=run(variant,['search',c.query,'--index','bench','--offset',String(c.offset)]);
    assert.equal(result.engine,'sqlite-trigram');assert.equal(result.complete,true);
    const signature=sha(JSON.stringify([result.paths,result.coverage,result.nextOffset]));
    if(variant==='candidate')assert.equal(signature,(preflight.baseline[c.id] as {signature:string}).signature,c.id+' changes matching/count/order');
    preflight[variant][c.id]={signature,matched:result.coverage.matched,returned:result.paths.length};
  }
}
const measurements:Record<string,{baseline:HyperfineResult;candidate:HyperfineResult;speedup:number}>={};
for(const c of cases){
  if(reusable&&previous.measurements[c.id]){measurements[c.id]=previous.measurements[c.id];continue;}
  const command=(variant:keyof typeof binaries)=>['env',`FE_DATA_DIR=${envFor(variant).FE_DATA_DIR}`,`FE_CONFIG_DIR=${envFor(variant).FE_CONFIG_DIR}`,binaries[variant],'search',c.query,'--index','bench','--offset',String(c.offset),'--json'].map(quote).join(' ');
  const file=path.join(output,c.id+'.json');
  console.log(execFileSync('hyperfine',['--warmup','2','--runs','10','--shell','none','--export-json',file,'--command-name','baseline',command('baseline'),'--command-name','candidate',command('candidate')],{encoding:'utf8',timeout:60000,maxBuffer:1024**2}));
  const result=JSON.parse(fs.readFileSync(file,'utf8')) as {results:(HyperfineResult|HyperfineV2)[]};
  const normalize=(r:HyperfineResult|HyperfineV2):HyperfineResult=>'measurements' in r ? {command:r.name,mean:r.summary.time_wall_clock.mean,stddev:r.summary.time_wall_clock.stddev,times:r.measurements.map(s=>s.time_wall_clock.value),exit_codes:r.measurements.map(s=>s.exit_code)} : r;
  const [before,after]=result.results.map(normalize);assert.equal(before.times.length,10);assert.equal(after.times.length,10);
  assert([...before.exit_codes,...after.exit_codes].every(code=>code===0));
  measurements[c.id]={baseline:before,candidate:after,speedup:before.mean/after.mean};
}
const report={passed:true,rows,fixtureSha256:sha(paths.join('\n')),baselineSha256,candidateSha256,hyperfine:execFileSync('hyperfine',['--version'],{encoding:'utf8'}).trim(),runs:10,warmup:2,preflight,measurements,limits:['Synthetic saved paths, no filesystem traversal during queries','OS page cache uncontrolled; warm CLI process startup is included','No production-disk or cross-machine speed claim','Baseline and candidate run in separate Hyperfine groups; small differences may be noise']};
fs.writeFileSync(path.join(output,'summary.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({passed:true,rows,summary:Object.fromEntries(Object.entries(measurements).map(([id,r])=>[id,{baselineMs:r.baseline.mean*1000,candidateMs:r.candidate.mean*1000,speedup:r.speedup}]))}));
