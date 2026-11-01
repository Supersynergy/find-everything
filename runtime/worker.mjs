import { createInterface } from 'node:readline';
import { mkdir, readFile, writeFile, rename, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const root = path.dirname(fileURLToPath(import.meta.url));
const modelPath = path.join(root, 'model');
const revision = 'c28f2883575e590e04d3146ff0713c2448d691ba';
const files = {
  'onnx/audio_model_quantized.onnx': [34301667, '3fcff2c8824e7bcb83a983f2a49edab3b60cbcf4872ac70efee517355173bd1f'],
  'onnx/text_model_quantized.onnx': [126603263, '1a3df8b197e249816e08415fd040434c44762b2eea7eb7bf8a48a0f0bf3c14e5'],
  'config.json': [], 'preprocessor_config.json': [], 'tokenizer.json': [], 'tokenizer_config.json': [], 'special_tokens_map.json': [],
};
if (process.argv[2] === 'setup') {
  await mkdir(path.join(modelPath, 'onnx'), { recursive: true, mode: 0o700 });
  let old; try { old = JSON.parse(await readFile(path.join(root, 'ready.json'), 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const receipts = {};
  for (const [name, [size, hash]] of Object.entries(files)) {
    const target = path.join(modelPath, name);
    if (old?.revision === revision && old.files?.[name]) {
      try {
        if ((await stat(target)).size === old.files[name].bytes && createHash('sha256').update(await readFile(target)).digest('hex') === (hash || old.files[name].sha256)) {
          receipts[name] = old.files[name]; continue;
        }
      } catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
    const response = await fetch(`https://huggingface.co/Xenova/clap-htsat-unfused/resolve/${revision}/${name}`, { signal: AbortSignal.timeout(120000) });
    if (!response.ok) throw new Error(`Model download ${name}: ${response.status}`);
    const chunks = []; let length = 0;
    for await (const chunk of response.body) { length += chunk.length; if (length > (size || 8 * 1024 * 1024)) throw new Error('Model download exceeds limit'); chunks.push(chunk); }
    const data = Buffer.concat(chunks), sha256 = createHash('sha256').update(data).digest('hex');
    if ((size && length !== size) || (hash && sha256 !== hash)) throw new Error(`Integrity failure: ${name}`);
    await writeFile(target + '.tmp', data, { mode: 0o600 }); await rename(target + '.tmp', target);
    receipts[name] = { bytes: length, sha256 }; console.error(`Downloaded ${name}: ${length} bytes`);
  }
  await writeFile(path.join(root, 'ready.json.tmp'), JSON.stringify({ revision, model: 'Xenova/clap-htsat-unfused', dtype: 'q8', license: 'Apache-2.0 (LAION base model)', files: receipts }, null, 2), { mode: 0o600 });
  await rename(path.join(root, 'ready.json.tmp'), path.join(root, 'ready.json'));
  console.log(JSON.stringify({ ready: true, revision, bytes: Object.values(receipts).reduce((n, r) => n + r.bytes, 0) }));
  process.exit(0);
}
const { env, AutoTokenizer, AutoProcessor, ClapTextModelWithProjection, ClapAudioModelWithProjection } = await import('@huggingface/transformers');
env.allowRemoteModels = false; env.allowLocalModels = true; env.useFSCache = false;
const opts = { dtype: 'q8', local_files_only: true, session_options: { intraOpNumThreads: 2, interOpNumThreads: 1, executionMode: 'sequential' } };
let textModel, audioModel, tokenizer, processor;
const normalized = tensor => {
  const vector = Array.from(tensor.data); const length = Math.hypot(...vector);
  if (vector.length !== 512 || !Number.isFinite(length) || !length) throw new Error('Invalid audio embedding');
  return vector.map(v => v / length);
};
const exec = promisify(execFile);
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
let idle;
const resetIdle = () => { clearTimeout(idle); idle = setTimeout(() => process.exit(0), 60000); idle.unref(); };
resetIdle();
for await (const line of input) {
  clearTimeout(idle);
  let id, stage = 'runtime';
  try {
    if (line.length > 16384) throw new Error('Request too large');
    const request = JSON.parse(line); id = request.id;
    let vector;
    if (request.kind === 'text' && typeof request.text === 'string' && request.text.length <= 512) {
      tokenizer ??= await AutoTokenizer.from_pretrained(modelPath, { local_files_only: true });
      textModel ??= await ClapTextModelWithProjection.from_pretrained(modelPath, opts);
      vector = normalized((await textModel(tokenizer(request.text, { truncation: true, max_length: 77 }))).text_embeds);
    } else if (request.kind === 'audio' && typeof request.path === 'string' && path.isAbsolute(request.path)) {
      processor ??= await AutoProcessor.from_pretrained(modelPath, { local_files_only: true });
      audioModel ??= await ClapAudioModelWithProjection.from_pretrained(modelPath, opts);
      stage = 'decode';
      const { stdout } = await exec(process.env.FE_FFMPEG || '/opt/homebrew/bin/ffmpeg', ['-v', 'error', '-nostdin', '-threads', '1', '-protocol_whitelist', 'file,pipe', '-i', request.path, '-t', '10', '-vn', '-ac', '1', '-ar', '48000', '-f', 'f32le', 'pipe:1'], { encoding: 'buffer', timeout: 5000, maxBuffer: 2000000, killSignal: 'SIGKILL' });
      const samples = new Float32Array(stdout.buffer.slice(stdout.byteOffset, stdout.byteOffset + stdout.byteLength));
      if (!samples.length) throw new Error('Empty decoded audio');
      stage = 'runtime';
      vector = normalized((await audioModel(await processor(samples))).audio_embeds);
    } else throw new Error('Unsupported embedding request');
    console.log(JSON.stringify({ id, vector }));
  } catch (error) { console.log(JSON.stringify({ id, error: String(error.message).slice(0, 500), code: stage === 'decode' ? 'AUDIO_DECODE' : 'MODEL_RUNTIME' })); }
  resetIdle();
}
clearTimeout(idle);
