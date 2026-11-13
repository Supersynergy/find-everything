/** Own only bounded float32 payloads. Keys are digests, never document text. */
export class EmbeddingCache {
  private entries=new Map<string,Float32Array>();
  private used=0;
  constructor(private readonly limit=512,private readonly budget=2*1024*1024) {}
  get bytes(){return this.used;}
  get size(){return this.entries.size;}
  private cost(key:string,value:Float32Array){return Buffer.byteLength(key)+value.byteLength+64;}
  get(key:string):Float32Array|undefined {
    const value=this.entries.get(key);if(!value)return;
    this.entries.delete(key);this.entries.set(key,value);return value.slice();
  }
  set(key:string,input:readonly number[]):void {
    const value=Float32Array.from(input);
    if(value.length!==768||!value.every(Number.isFinite))return;
    const cost=this.cost(key,value);if(cost>this.budget||this.limit<1)return;
    const previous=this.entries.get(key);if(previous){this.used-=this.cost(key,previous);this.entries.delete(key);}
    while(this.entries.size>=this.limit||this.used+cost>this.budget){const first=this.entries.keys().next().value!;const old=this.entries.get(first)!;this.used-=this.cost(first,old);this.entries.delete(first);}
    this.entries.set(key,value);this.used+=cost;
  }
  clear(){this.entries.clear();this.used=0;}
}
