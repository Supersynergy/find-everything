import sqlite3,json,re,heapq,functools
from pathlib import Path

def prepare(source,destination):
    j=json.loads(Path(source).read_text());v=j['model']['vocab']
    assert j['model']['type']=='BPE' and not j['model']['ignore_merges'] and j['model']['byte_fallback']
    assert j['normalizer']=={'type':'Replace','pattern':{'String':' '},'content':'▁'}
    assert j['pre_tokenizer']=={'type':'Split','pattern':{'String':' '},'behavior':'MergedWithPrevious','invert':False}
    assert all(not a[k] for a in j['added_tokens'] for k in ['single_word','lstrip','rstrip','normalized'])
    db=sqlite3.connect(destination);db.executescript('CREATE TABLE vocab(token TEXT PRIMARY KEY,id INTEGER NOT NULL) WITHOUT ROWID;CREATE TABLE merges(a INTEGER,b INTEGER,rank INTEGER,id INTEGER,PRIMARY KEY(a,b)) WITHOUT ROWID;CREATE TABLE added(token TEXT PRIMARY KEY,id INTEGER) WITHOUT ROWID;')
    with db:
        db.executemany('INSERT INTO vocab VALUES(?,?)',v.items())
        db.executemany('INSERT INTO merges VALUES(?,?,?,?)',((v[a],v[b],i,v[a+b]) for i,(a,b) in enumerate(j['model']['merges'])))
        db.executemany('INSERT INTO added VALUES(?,?)',((a['content'],a['id']) for a in j['added_tokens']))
    db.close()

class CompactTokenizer:
    def __init__(self,file):
        self.db=sqlite3.connect(f'file:{file}?mode=ro',uri=True)
        self.db.execute('PRAGMA cache_size=-2048');self.db.execute('PRAGMA mmap_size=0')
        self.added=dict(self.db.execute('SELECT token,id FROM added'))
        self.special=re.compile('|'.join(re.escape(t) for t in sorted(self.added,key=len,reverse=True)))
        self.token=functools.lru_cache(maxsize=4096)(self._token)
        self.merge=functools.lru_cache(maxsize=16384)(self._merge)
    def _token(self,t):
        r=self.db.execute('SELECT id FROM vocab WHERE token=?',(t,)).fetchone();return r[0] if r else None
    def _merge(self,a,b):
        return self.db.execute('SELECT rank,id FROM merges WHERE a=? AND b=?',(a,b)).fetchone()
    def piece(self,text):
        ids=[]
        for c in text.replace(' ','▁'):
            n=self.token(c)
            if n is None:ids.extend(self.token(f'<0x{b:02X}>') for b in c.encode())
            else:ids.append(n)
        size=len(ids);prev=list(range(-1,size-1));nxt=list(range(1,size+1));alive=[True]*size;heap=[]
        def push(i):
            if i>=0 and nxt[i]<size:
                pair=self.merge(ids[i],ids[nxt[i]])
                if pair:heapq.heappush(heap,(pair[0],i,nxt[i],ids[i],ids[nxt[i]],pair[1]))
        for i in range(size):push(i)
        while heap:
            _,i,j,a,b,merged=heapq.heappop(heap)
            if not alive[i] or not alive[j] or nxt[i]!=j or ids[i]!=a or ids[j]!=b:continue
            ids[i]=merged;alive[j]=False;nxt[i]=nxt[j]
            if nxt[j]<size:prev[nxt[j]]=i
            push(prev[i]);push(i)
        return [n for i,n in enumerate(ids) if alive[i]]
    def encode(self,text):
        result=[];start=0
        for m in self.special.finditer(text):
            result.extend(self.piece(text[start:m.start()]));result.append(self.added[m.group()]);start=m.end()
        result.extend(self.piece(text[start:]));return [2]+result[:254]+[1]

if __name__=='__main__':
 import sys
 prepare(sys.argv[1],sys.argv[2])
