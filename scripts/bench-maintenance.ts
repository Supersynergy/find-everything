import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
const [mode,baselineArg,candidateArg,outputArg]=process.argv.slice(2);
const sha=(file:string)=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const queries=['ne sort:name view:all','al sort:name view:all'];
function run(cli:string,data:string){
  const samples=[];
  for(let i=0;i<6;i++){
    const q=queries[i%2],started=performance.now();
    const r=JSON.parse(execFileSync(cli,['search',q,'--index','bench','-n','10','--json'],{env:{...process.env,FE_DATA_DIR:data,FE_CONFIG_DIR:path.join(data,'config')},encoding:'utf8',timeout:30000}));
    const rows=Number(fs.readFileSync(path.join(data,'rows'),'utf8'));
    const expected=i%2?Math.floor(rows/3):rows-Math.floor(rows/3);
    assert.equal(r.coverage.matched,expected);assert.equal(r.paths.length,10);
    samples.push({query:q,ms:performance.now()-started,matched:r.coverage.matched,signature:createHash('sha256').update(JSON.stringify(r.paths)).digest('hex')});
  }
  return samples;
}
if(mode==='run'){console.log(JSON.stringify(run(path.resolve(baselineArg),path.resolve(candidateArg))));}
else if(mode==='compare'){
  const baseline=path.resolve(baselineArg),candidate=path.resolve(candidateArg),out=path.resolve(outputArg);fs.mkdirSync(out,{recursive:true});
  const data=path.join(out,'data');fs.mkdirSync(data,{recursive:true});const rows=1000000;
  const root=path.join(data,'empty-root');fs.mkdirSync(root,{recursive:true});
  execFileSync(baseline,['index',root,'--name','bench','--json'],{env:{...process.env,FE_DATA_DIR:data,FE_CONFIG_DIR:path.join(data,'config')},timeout:30000});
  const stream=fs.createWriteStream(path.join(data,'index-bench.txt'));let chunk='';for(let i=0;i<rows;i++){chunk+='/fixture/root/'+(i%3===2?'alpha-':'neo-')+String(i).padStart(7,'0')+'.txt\n';if(chunk.length>=256*1024){if(!stream.write(chunk))await new Promise(r=>stream.once('drain',r));chunk='';}}stream.end(chunk);await new Promise(r=>stream.once('finish',r));
  fs.writeFileSync(path.join(data,'rows'),String(rows));fs.mkdirSync(path.join(data,'config'),{recursive:true});
  execFileSync(baseline,['prepare','--index','bench','--seconds','300'],{env:{...process.env,FE_DATA_DIR:data,FE_CONFIG_DIR:path.join(data,'config')},encoding:'utf8',timeout:300000});
  const before=run(baseline,data),after=run(candidate,data);assert.deepEqual(after.map(r=>r.signature),before.map(r=>r.signature));
  fs.writeFileSync(path.join(out,'first.json'),JSON.stringify({before,after},null,2));
  const command=(cli:string)=>[process.execPath,path.resolve('scripts/bench-maintenance.ts'),'run',cli,data].map(s=>"'"+s.replaceAll("'","'\\''")+"'").join(' ');
  execFileSync('hyperfine',['--warmup','1','--runs','3','--metrics','time','--export-json',path.join(out,'hyperfine.json'),'--command-name','0.3.9',command(baseline),'--command-name','0.3.40',command(candidate)],{stdio:'inherit',timeout:120000});
  const report={passed:true,rows,queries,requestsPerCommand:6,baselineSha256:sha(baseline),candidateSha256:sha(candidate),first: {before,after},hyperfine:JSON.parse(fs.readFileSync(path.join(out,'hyperfine.json'),'utf8')),limits:['Saved synthetic names; no file traversal','Six fresh CLI processes per command; no native UI timing','One warmup and three measured commands per version','OS cache state uncontrolled; compare is specific to repeated exact counts across process restarts','First unseen queries still compute their exact counts']};
  fs.writeFileSync(path.join(out,'summary.json'),JSON.stringify(report,null,2));
}else throw new Error('Usage: compare BASELINE CANDIDATE OUTPUT | run CLI DATA');
