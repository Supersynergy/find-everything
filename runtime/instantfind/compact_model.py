"""Split the pinned Gemma graph from its large token table, without ONNX dependencies."""
from pathlib import Path
import os,json
TABLE_BYTES=125829120
NODE='/model/embed_tokens/Gather_Q4'
TABLES={'model.embed_tokens.weight_Q4','model.embed_tokens.weight_scales'}
INPUT='/model/embed_tokens/Gather/output_0'

def varint(n):
    out=bytearray()
    while n>127:out.append((n&127)|128);n>>=7
    out.append(n);return bytes(out)

def readvar(data,at):
    value=0
    for shift in range(0,70,7):
        if at>=len(data):raise ValueError('Truncated protobuf')
        b=data[at];at+=1;value|=(b&127)<<shift
        if not b&128:return value,at
    raise ValueError('Invalid protobuf varint')

def field(n,value,wire=2):
    return varint((n<<3)|wire)+(varint(len(value))+value if wire==2 else varint(value))

def fields(data):
    at=0
    while at<len(data):
        start=at;tag,at=readvar(data,at);wire=tag&7
        if wire==0:_,end=readvar(data,at);value=data[at:end]
        elif wire in (1,5):end=at+(8 if wire==1 else 4);value=data[at:end]
        elif wire==2:
            size,at=readvar(data,at);end=at+size;value=data[at:end]
        else:raise ValueError('Unsupported pinned protobuf wire type')
        if end>len(data):raise ValueError('Truncated protobuf field')
        yield tag>>3,wire,value,data[start:end];at=end

def string(data,number):
    return next((v.decode() for n,w,v,_ in fields(data) if n==number and w==2),'')

def transform_tensor(data):
    result=[]
    for n,w,value,raw in fields(data):
        if n==13:
            key=string(value,1);text=string(value,2)
            if key=='location':
                if text!='model_q4.onnx_data':raise ValueError('Unexpected weights file')
                text='core.data'
            elif key=='offset':
                offset=int(text)-TABLE_BYTES
                if offset<0:raise ValueError('Unexpected external table offset')
                text=str(offset)
            raw=field(13,field(1,key.encode())+field(2,text.encode()))
        result.append(raw)
    return b''.join(result)

def transform(data):
    result=[];graphs=0
    for n,w,value,raw in fields(data):
        if n==7:
            graphs+=1;parts=[];nodes=0;tables=0
            for gn,gw,gv,gr in fields(value):
                if gn==1 and string(gv,3)==NODE:nodes+=1;continue
                if gn==5:
                    if string(gv,8) in TABLES:tables+=1;continue
                    gr=field(5,transform_tensor(gv))
                parts.append(gr)
            if nodes!=1 or tables!=2:raise ValueError('Pinned embedding layout changed')
            shape=b''.join(field(1,field(2,x.encode())) for x in ['batch_size','sequence_length'])+field(1,field(1,768,0))
            tensor=field(1,1,0)+field(2,shape)
            parts.append(field(11,field(1,INPUT.encode())+field(2,field(1,tensor))))
            raw=field(7,b''.join(parts))
        result.append(raw)
    if graphs!=1:raise ValueError('Pinned graph missing')
    return b''.join(result)

def prepare(root):
    root=Path(root);directory=root/'onnx';graph=transform((directory/'model_q4.onnx').read_bytes())
    temporary=directory/'core.data.tmp'
    try:
        with (directory/'model_q4.onnx_data').open('rb') as source,temporary.open('wb') as out:
            source.seek(TABLE_BYTES)
            while chunk:=source.read(1024*1024):out.write(chunk)
        os.chmod(temporary,0o600);temporary.replace(directory/'core.data')
        target=directory/'core.onnx';target.write_bytes(graph);os.chmod(target,0o600)
    finally:temporary.unlink(missing_ok=True)
    return {'graphBytes':len(graph),'weightsBytes':(directory/'core.data').stat().st_size}

if __name__=='__main__':
    import sys
    print(json.dumps(prepare(sys.argv[1])))
