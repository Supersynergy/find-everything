import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';

const root=path.resolve(import.meta.dir,'../..');
const version=(JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8')) as {version:string}).version;
const app=path.join(root,'app/Find Everything.app'),out=path.join(root,'release-artifacts');
const run=(command:string,args:string[])=>execFileSync(command,args,{cwd:root,encoding:'utf8',timeout:120000,maxBuffer:1024**2});
const sha=(file:string)=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
assert.match(version,/^\d+\.\d+\.\d+$/);
assert.equal(run(path.join(app,'Contents/Helpers/fe'),['--version']).trim(),'fe '+version);
run('codesign',['--verify','--deep','--strict',app]);
fs.mkdirSync(out,{recursive:true});
const archive=path.join(out,'FindEverything.app.zip');
run('/usr/bin/ditto',['-c','-k','--sequesterRsrc','--keepParent',app,archive]);
const files=run('git',['ls-files','src','runtime/instantfind','app/Sources','app/MediaProbe.swift','app/FileEvents.swift','app/ContentProbe.swift','app/Package.swift','app/bundle-app.sh','package.json']).trim().split('\n').filter(Boolean);
const manifest={version,tag:`v${version}`,architecture:'arm64',minimumMacOS:'15.0',preview:false,notarized:false,
  signing:'Existing local certificate; not a trusted Developer ID distribution',
  codeFiles:files,assets:[{name:path.basename(archive),bytes:fs.statSync(archive).size,sha256:sha(archive)}]};
const manifestFile=path.join(out,'release.json');fs.writeFileSync(manifestFile,JSON.stringify(manifest,null,2)+'\n');
fs.writeFileSync(path.join(out,'SHA256SUMS.txt'),`${sha(archive)}  ${path.basename(archive)}\n${sha(manifestFile)}  release.json\n`);
console.log(JSON.stringify({version,archiveBytes:fs.statSync(archive).size,sha256:sha(archive)}));
