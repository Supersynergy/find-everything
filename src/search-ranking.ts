import path from 'node:path';
import type {ParsedQuery} from './engine';

// Textual relevance always wins over a bounded learned preference. Data files
// remain searchable: only generated artifacts are hidden by the smart view.
const DOCUMENTS=['md','mdx','markdown','txt','pdf','rtf','doc','docx','odt','pages','epub','org'];
const MEDIA=['mp4','mov','mkv','webm','m4v','avi','mp3','wav','flac','m4a','aac','aiff','aif','ogg','opus','png','jpg','jpeg','gif','webp','heic','tif','tiff','svg','avif','bmp'];
const CODE=['ts','tsx','js','jsx','py','rs','go','swift','sh','rb','java','c','cpp','h','css','html','vue','svelte'];
const DATA=['json','jsonl','ndjson','yaml','yml','toml','xml','csv','ini','plist','db','sqlite','sqlite3','log','lock','map'];
const BINARY=['o','a','so','dylib','dll','exe','bin','pyc','class','wasm','tmp'];
const TYPES=[{extensions:[...DOCUMENTS,...MEDIA],priority:0},{extensions:['app'],priority:2},{extensions:CODE,priority:5},{extensions:DATA,priority:8},{extensions:BINARY,priority:10}];
const queryTokens=(query:string)=>query.match(/(?:[^\s"]|"(?:\\.|[^"\\])*")+/g)||[];
export function withSmartView(query:string){return queryTokens(query).some(t=>/^view:/i.test(t))?query:query+' view:smart';}
export function withAllView(query:string){return queryTokens(query).filter(t=>!/^view:/i.test(t)).join(' ')+' view:all';}
const groups=(pq:ParsedQuery)=>pq.fuzzy.map(t=>t.startsWith("'")?[t.slice(1)]:t.split('|').filter(Boolean)).map(g=>g.map(t=>t.toLowerCase()));
export function rankText(pq:ParsedQuery){return groups(pq).map(g=>g.join('|')).join(' ');}
const priorities=new Map(TYPES.flatMap(t=>t.extensions.map(ext=>[ext,t.priority] as const)));
export function contentPriority(name:string){return priorities.get(path.extname(name).slice(1).toLowerCase())??4;}
export function learningContext(pq:ParsedQuery){return !pq.fuzzy.length&&!pq.constraints.length&&!pq.semantic&&!pq.content&&!pq.sizeFilter&&!pq.dmFilter&&!pq.mediaFilters.length?'':JSON.stringify([rankText(pq),pq.constraints,pq.semantic,pq.content,pq.sizeFilter,pq.dmFilter,pq.mediaFilters,pq.favorites!==undefined]);}
export function relevanceScore(p:string,pq:ParsedQuery,boost=0){
  const name=path.basename(p.replace(/\/$/,'' )).toLowerCase(),terms=groups(pq),phrase=rankText(pq),stem=name.slice(0,name.length-path.extname(name).length);
  const lexical=!terms.length?0:name===phrase||stem===phrase?0:phrase&&!phrase.includes('|')&&name.startsWith(phrase)?1:terms.every(g=>g.some(t=>name.includes(t)))?2:3;
  return lexical*100+contentPriority(name)*5-Math.min(48,Math.max(0,boost));
}

// Bind every query-derived value. This ORDER BY is evaluated before LIMIT,
// so a Markdown file on page 100 can outrank a JSON file on page 1.
export function relevanceOrder(pq:ParsedQuery,selections:{id:number;boost:number}[]=[]) {
  const args:any[]=[],terms=groups(pq),phrase=rankText(pq);
  let lexical='0';
  if(terms.length){
    args.push(phrase,phrase,phrase);
    const all=terms.map(g=>'('+g.map(t=>{args.push(t);return 'instr(f.nameKey,?)>0';}).join(' OR ')+')').join(' AND ');
    lexical=`CASE WHEN f.nameKey=? OR (substr(f.nameKey,1,length(?))=? AND substr(f.nameKey,${[...phrase].length+1},1)='.' AND instr(substr(f.nameKey,${[...phrase].length+2}),'.')=0) THEN 0`;
    if(!phrase.includes('|')){lexical+=' WHEN substr(f.nameKey,1,?)=? THEN 1';args.splice(3,0,[...phrase].length,phrase);}
    lexical+=` WHEN ${all} THEN 2 ELSE 3 END`;
  }
  const content='CASE '+TYPES.map(t=>{
    const lengths=[...new Set(t.extensions.map(ext=>ext.length+1))];
    return 'WHEN ('+lengths.map(n=>`substr(f.nameKey,-${n}) IN (`+t.extensions.filter(ext=>ext.length+1===n).map(ext=>`'.${ext}'`).join(',')+')').join(' OR ')+') THEN '+t.priority;
  }).join(' ')+' ELSE 4 END';
  let learned='0';
  if(selections.length){learned='CASE f.id '+selections.map(s=>{args.push(s.id,s.boost);return 'WHEN ? THEN ?';}).join(' ')+' ELSE 0 END';}
  return {sql:`((${lexical})*100+(${content})*5-(${learned}))`,args};
}
