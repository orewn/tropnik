// Exercise the actual browser worker module in a Node isolate without a browser or server.
import {parentPort} from 'node:worker_threads';
globalThis.postMessage = (message, transfer) => parentPort.postMessage(message, transfer);
await import('../../lib/terrain-preparation.worker.ts');
parentPort.on('message', data => globalThis.onmessage({data}));
