import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { Worker, MessageChannel, parentPort, workerData } from 'node:worker_threads';
import { newMessagePortRpcSession, RpcTarget } from 'capnweb';

// Each line written to the process has exactly one ordered response.
class Session extends RpcTarget {
  #child;
  #lines;
  #responses = Promise.resolve();
  constructor(command) {
    super();
    const [program, ...args] = command;
    this.#child = spawn(program, args, { stdio: ['pipe', 'pipe', 'inherit'] });
    this.#lines = createInterface({ input: this.#child.stdout })[Symbol.asyncIterator]();
    this.#child.on('error', error => this.#child.stdout.destroy(error));
    this.#child.stdin.on('error', error => this.#child.stdout.destroy(error));
  }
  search(query) {
    // Submit now. Serialize only the reads so pipelined requests can reach stdin.
    this.#child.stdin.write(JSON.stringify(query) + '\n');
    const response = this.#responses.then(async () => {
      const { value, done } = await this.#lines.next();
      if (done) throw Error('Search session ended before replying');
      const reply = JSON.parse(value);
      if (reply.error) throw Error(reply.error);
      return reply.data;
    });
    this.#responses = response.catch(() => {});
    return response;
  }
  close() { this.#child.stdin.end(); }
}

if (parentPort) {
  const session = new Session(workerData.command);
  newMessagePortRpcSession(workerData.port, session);
  parentPort.once('message', () => { session.close(); workerData.port.close(); });
} else {
  const [transport, submission, queryJson, ...command] = process.argv.slice(2);
  const queries = JSON.parse(queryJson);
  assert(['pipe','rpc'].includes(transport) && ['serial','pipeline'].includes(submission));
  assert(Array.isArray(queries) && queries.length > 0 && queries.length <= 64 && command.length);
  let session, worker, port;
  if (transport === 'pipe') {
    session = new Session(command);
  } else {
    const channel = new MessageChannel();
    port = channel.port1;
    worker = new Worker(new URL(import.meta.url), {
      workerData: { command, port: channel.port2 }, transferList: [channel.port2]
    });
    worker.on('error', error => port.close());
    session = newMessagePortRpcSession(port);
  }
  try {
    await session.search(queries[0]); // Same warm-up for all four cells.
    const start = performance.now();
    const replies = [];
    if (submission === 'pipeline') replies.push(...await Promise.all(queries.map(q => session.search(q))));
    else for (const q of queries) replies.push(await session.search(q));
    console.log(JSON.stringify({ ms: performance.now()-start, replies }));
  } finally {
    if (worker) {
      const exited = once(worker, 'exit');
      worker.postMessage('close');
      port.close();
      await exited;
    } else session.close();
  }
}
