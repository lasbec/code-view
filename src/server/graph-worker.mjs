import { parentPort, workerData } from 'node:worker_threads';
import { readGraph } from './graph.mjs';
try { parentPort.postMessage(readGraph(workerData.path, workerData.config)); }
catch (error) { throw error; }
