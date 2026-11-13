"""Local CPU-only Gemma embedding worker. No model downloads or remote code."""
import json,sys,time,os,resource
from pathlib import Path
import numpy as np
import onnxruntime as ort
from tokenizers import Tokenizer

root=Path(sys.argv[1]);start=time.perf_counter()
options=ort.SessionOptions();options.intra_op_num_threads=2;options.inter_op_num_threads=1
options.enable_cpu_mem_arena=False;options.enable_mem_pattern=False
session=ort.InferenceSession(str(root/'onnx/model_q4.onnx'),sess_options=options,providers=['CPUExecutionProvider'])
tokenizer=Tokenizer.from_file(str(root/'tokenizer.json'))
tokenizer.enable_truncation(max_length=256)
tokenizer.enable_padding(pad_id=tokenizer.token_to_id('<pad>'),pad_token='<pad>')
setup_ms=1000*(time.perf_counter()-start)
inputs={x.name for x in session.get_inputs()};outputs=[x.name for x in session.get_outputs()]
for line in sys.stdin:
    try:
        if len(line.encode())>2*1024*1024:raise ValueError('Request too large')
        request=json.loads(line);texts=request['texts']
        if not isinstance(texts,list) or not 1<=len(texts)<=4 or any(not isinstance(t,str) or not t.strip() or len(t)>8000 for t in texts):raise ValueError('Use 1–4 bounded texts')
        if request['kind'] not in ('query','document'):raise ValueError('Invalid embedding kind')
        prefix='task: search result | query: ' if request['kind']=='query' else ''
        tokens=tokenizer.encode_batch([prefix+t for t in texts])
        data={'input_ids':np.array([t.ids for t in tokens],dtype=np.int64),'attention_mask':np.array([t.attention_mask for t in tokens],dtype=np.int64)}
        if 'position_ids' in inputs:data['position_ids']=np.broadcast_to(np.arange(data['input_ids'].shape[1],dtype=np.int64),data['input_ids'].shape)
        if 'token_type_ids' in inputs:data['token_type_ids']=np.array([t.type_ids for t in tokens],dtype=np.int64)
        values=session.run(None,data)
        if 'sentence_embedding' in outputs:vectors=values[outputs.index('sentence_embedding')]
        else:
            hidden=values[0];mask=data['attention_mask'].astype(hidden.dtype)
            vectors=(hidden*mask[:,:,None]).sum(1)/np.maximum(mask.sum(1)[:,None],1)
        vectors/=np.maximum(np.linalg.norm(vectors,axis=1,keepdims=True),1e-12)
        if vectors.shape!=(len(texts),768) or not np.isfinite(vectors).all():raise ValueError('Invalid model output')
        reply={'id':request['id'],'vectors':vectors.astype(np.float32).tolist(),'pid':os.getpid(),'setupMs':setup_ms,'peakRssMiB':resource.getrusage(resource.RUSAGE_SELF).ru_maxrss/1048576}
    except Exception as error:
        reply={'id':locals().get('request',{}).get('id'), 'error':str(error)[:500]}
    print(json.dumps(reply,separators=(',',':')),flush=True)
