"""Local CPU-only Gemma embedding worker. No model downloads or remote code."""
import json,sys,time,os,resource
sys.dont_write_bytecode=True
from pathlib import Path
import numpy as np
import onnxruntime as ort
from compact_tokenizer import CompactTokenizer

root=Path(sys.argv[1]);start=time.perf_counter()
options=ort.SessionOptions();options.intra_op_num_threads=2;options.inter_op_num_threads=1
options.enable_cpu_mem_arena=False;options.enable_mem_pattern=False
session=ort.InferenceSession(str(root/'onnx/model_q4.onnx'),sess_options=options,providers=['CPUExecutionProvider'])
compact=(root/'tokenizer.sqlite').is_file()
if compact:
    tokenizer=CompactTokenizer(root/'tokenizer.sqlite')
else:
    from tokenizers import Tokenizer
    tokenizer=Tokenizer.from_file(str(root/'tokenizer.json'))
    tokenizer.enable_truncation(max_length=256)
setup_ms=1000*(time.perf_counter()-start)
inputs={x.name for x in session.get_inputs()};outputs=[x.name for x in session.get_outputs()]
for line in sys.stdin:
    try:
        if len(line.encode())>2*1024*1024:raise ValueError('Request too large')
        request=json.loads(line);texts=request['texts']
        if not isinstance(texts,list) or not 1<=len(texts)<=4 or any(not isinstance(t,str) or not t.strip() or len(t)>8000 for t in texts):raise ValueError('Use 1–4 bounded texts')
        if request['kind'] not in ('query','document'):raise ValueError('Invalid embedding kind')
        prefix='task: search result | query: ' if request['kind']=='query' else ''
        tokens=[tokenizer.encode(prefix+t) if compact else tokenizer.encode(prefix+t).ids for t in texts]
        # Index documents one at a time: padding four long texts multiplies attention scratch RAM.
        batches=[[t] for t in tokens] if request['kind']=='document' else [tokens]
        collected=[]
        for batch in batches:
            width=max(map(len,batch))
            data={'input_ids':np.array([t+[0]*(width-len(t)) for t in batch],dtype=np.int64),'attention_mask':np.array([[1]*len(t)+[0]*(width-len(t)) for t in batch],dtype=np.int64)}
            if 'position_ids' in inputs:data['position_ids']=np.broadcast_to(np.arange(data['input_ids'].shape[1],dtype=np.int64),data['input_ids'].shape)
            if 'token_type_ids' in inputs:data['token_type_ids']=np.zeros_like(data['input_ids'])
            values=session.run(None,data)
            if 'sentence_embedding' in outputs:vectors=values[outputs.index('sentence_embedding')]
            else:
                hidden=values[0];mask=data['attention_mask'].astype(hidden.dtype)
                vectors=(hidden*mask[:,:,None]).sum(1)/np.maximum(mask.sum(1)[:,None],1)
            vectors/=np.maximum(np.linalg.norm(vectors,axis=1,keepdims=True),1e-12)
            collected.extend(vectors.astype(np.float32).tolist())
        vectors=np.asarray(collected,dtype=np.float32)
        if vectors.shape!=(len(texts),768) or not np.isfinite(vectors).all():raise ValueError('Invalid model output')
        reply={'id':request['id'],'vectors':vectors.astype(np.float32).tolist(),'pid':os.getpid(),'setupMs':setup_ms,'peakRssMiB':resource.getrusage(resource.RUSAGE_SELF).ru_maxrss/1048576}
    except Exception as error:
        reply={'id':locals().get('request',{}).get('id'), 'error':str(error)[:500]}
    print(json.dumps(reply,separators=(',',':')),flush=True)
