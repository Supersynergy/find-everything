import * as path from 'node:path';
import * as os from 'node:os';

export function humanBytes(n?:number):string {
  if(n===undefined)return '';
  const units=['B','KB','MB','GB'];let i=0;
  while(n>=1024&&i<units.length-1){n/=1024;i++;}
  return `${n.toFixed(i?1:0)} ${units[i]}`;
}

export function prettyPath(p:string):string {
  const value=path.dirname(p).replace(os.homedir(),'~');
  if(value.length<=60)return value;
  const parts=value.split('/').filter(Boolean);
  return `${parts.slice(0,2).join('/')}/…/${parts.slice(-2).join('/')}`;
}
