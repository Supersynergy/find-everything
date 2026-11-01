/** Bounded, opt-in file clauses. Unknown descriptions retain the audio route. */
export function fileIntent(text:string):string|undefined {
  if(!/\b(pdfs?|bilder|fotos?|images?|photos?|videos?|dokumente|documents?|archive|archives?|dateien|files?|favoriten|favorites|favorisiert\w*)\b/i.test(text))return;
  const fields=new Map<string,string>();
  const put=(key:string,value:string)=>{if(fields.has(key))throw new Error(`Use one ${key} condition per natural-language clause`);fields.set(key,value);};
  const encoded='"(?:\\\\.|[^"\\\\])*"';
  let value=text.replace(new RegExp('\\b(?:im Ordner|in folder|in)\\s+('+encoded+')','gi'),(_,q)=>{
    const folder=JSON.parse(q);if(!folder.startsWith('/')&&!folder.startsWith('~/'))throw new Error('Use an absolute folder path or ~/ inside a file clause');
    put('in',JSON.stringify(folder));return ' ';
  }).replace(new RegExp('\\b(?:mit (?:dem )?Namen|named)\\s+('+encoded+')','gi'),(_,q)=>{
    const name=JSON.parse(q);if(!name||name.includes('/'))throw new Error('Use a filename fragment without /');put('name',JSON.stringify(name));return ' ';
  });
  const folders:Record<string,string>={downloads:'Downloads',dokumente:'Documents',dokumenten:'Documents',documents:'Documents',desktop:'Desktop',schreibtisch:'Desktop',bilder:'Pictures',pictures:'Pictures',musik:'Music',music:'Music'};
  value=value.replace(/\b(?:in|im)(?: meinen| den| the)?\s+(downloads|dokumenten?|documents|desktop|schreibtisch|bilder|pictures|musik|music)(?:[- ]ordner)?\b/gi,(_,folder)=>{put('in',JSON.stringify('~/'+folders[folder.toLowerCase()]));return ' ';});
  const groups:[RegExp,string][]=[[/\bpdfs?\b/gi,'ext:pdf'],[/\b(bilder|fotos?|images?|photos?)\b/gi,'type:image'],[/\bvideos?\b/gi,'type:video'],[/\b(dokumente|documents?)\b/gi,'type:doc'],[/\b(archive|archives?)\b/gi,'type:zip']];
  const selected=new Set<string>();
  for(const [pattern,filter]of groups)value=value.replace(pattern,()=>{selected.add(filter);return ' ';});
  if(selected.size>1)throw new Error('Use one file group per clause; use ext:pdf;png for alternatives');
  value=value.replace(/\b(favoriten|favorites|favorisiert\w*)\b/gi,()=>{if(!fields.has('favorites'))put('favorites','true');return ' ';});
  value=value.toLowerCase().replace(/(?:^|\s)(größer als|groesser als|über|ueber|larger than|over|mindestens|at least|kleiner als|unter|smaller than|under|höchstens|hoechstens|at most)\s*(\d+(?:[.,]\d+)?)\s*(bytes?|kb|kilobytes?|mb|megabytes?|gb|gigabytes?)\b/g,(_,phrase,n,unit)=>{
    const op=/^(mindestens|at least)/.test(phrase)?'>=':/^(höchstens|hoechstens|at most)/.test(phrase)?'<=':/^(größer|groesser|über|ueber|larger|over)/.test(phrase)?'>':'<';
    put('size',op+n.replace(',','.')+({b:'b',k:'k',m:'m',g:'g'}[unit[0]]));return ' ';
  }).replace(/\b(?:(?:aus|in) den letzten|die letzten|letzte[n]?|(?:from )?the last|last)\s+(\d+)\s+(?:tagen?|days?)\b/g,(_,n)=>{
    if(Number(n)<1||Number(n)>365000)throw new Error('Use a day range from 1 to 365000');put('dm',Number(n)+'d');return ' ';
  });
  const sorts:[RegExp,string][]=[[/\b(größte zuerst|groesste zuerst|largest first)\b/g,'big'],[/\b(kleinste zuerst|smallest first)\b/g,'small'],[/\b(neueste zuerst|newest first)\b/g,'new'],[/(?:^|\s)(älteste zuerst|aelteste zuerst|oldest first)\b/g,'old'],[/\b(nach namen|by name)\b/g,'name']];
  for(const [pattern,sort]of sorts)value=value.replace(pattern,()=>{put('sort',sort);return ' ';});
  if(/[<>:=;"\x00-\x1f]/.test(value)||/(?:^|\s)(größer|groesser|über|ueber|kleiner|unter|mindestens|höchstens|hoechstens|larger|smaller|under|over|least|most|ordner|folder)\b/.test(value))throw new Error('Unsupported file condition; try (PDFs größer als 10 MB) or explicit search filters');
  const literal=value.replace(/\b(suche|finde|zeige|mir|bitte|alle|meine[nr]?|als|mit|aus|den|der|die|dem|und|dateien|files?|find|show|me|please|all|my|from|the|and)\b/g,' ').replace(/[,.!?]/g,' ').replace(/\s+/g,' ').trim();
  return [...selected,...['favorites','in','name','size','dm','sort'].flatMap(k=>fields.has(k)?[k+':'+fields.get(k)]:[]),...(literal?[JSON.stringify(literal)]:[])].join(' ');
}
