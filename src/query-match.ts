import type {ParsedQuery} from './engine';
import {omitted} from './file-filters';

export const smartCase=(text:string)=>/\p{Lu}/u.test(text);
export function wordMatch(haystack:string,needle:string,exact:boolean):boolean {
  let text=haystack.normalize('NFC'),term=needle.normalize('NFC');
  if(!exact){text=text.toLowerCase();term=term.toLowerCase();}
  if(!term)return false;
  const word=/[\p{L}\p{N}\p{M}_]/u;
  for(let at=text.indexOf(term);at>=0;at=text.indexOf(term,at+1)){
    const before=Array.from(text.slice(Math.max(0,at-2),at)).pop()||'';
    const after=Array.from(text.slice(at+term.length,at+term.length+2))[0]||'';
    if(!word.test(before)&&!word.test(after))return true;
  }
  return false;
}
export function queryMatcher(pq:ParsedQuery):(path:string)=>boolean {
  const constraints=pq.constraints.map(c=>({...c,re:new RegExp(c.pattern,(pq.matchCase===true&&c.literal!==undefined?'':'i')+'u')}));
  const groups=pq.fuzzy.map(t=>t.startsWith("'")?[t.slice(1)]:t.split('|').filter(Boolean));
  const favorites=pq.favorites?new Set(pq.favorites):undefined;
  const matches=(text:string,term:string,exact:boolean)=>pq.wholeWord?wordMatch(text,term,exact):exact?text.includes(term):text.toLowerCase().includes(term.toLowerCase());
  return p=>{
    const normalized=p.normalize('NFC');
    return (!favorites||favorites.has(p))&&!omitted(p,pq.omit)&&constraints.every(c=>{
      if(c.field==='folder'&&c.literal!==undefined){
        const clean=normalized.replace(/\/$/,''),parent=clean.slice(0,clean.lastIndexOf('/')+1);
        const target=pq.matchCase===true?parent:parent.toLowerCase(),term=pq.matchCase===true?c.literal:c.literal.toLowerCase();
        return (c.prefix?target.startsWith(term):target.includes(term))!==c.negate;
      }
      if(c.literal!==undefined&&c.field!=='folder'&&pq.wholeWord){
        const clean=normalized.replace(/\/$/,''),slash=clean.lastIndexOf('/');
        const target=c.field==='name'?clean.slice(slash+1):c.field==='folder'?normalized.slice(0,slash+1):normalized;
        return matches(target,c.literal,pq.matchCase??false)!==c.negate;
      }
      return c.re.test(normalized)!==c.negate;
    })&&groups.every(g=>g.some(t=>matches(normalized,t,pq.matchCase??smartCase(t))));
  };
}
