import { parentPort } from 'node:worker_threads';
import { extractFile } from './extract.js';

// Parses files for the Maestro graph off the main thread (#159).
parentPort.on('message', ({ id, source, relPath }) => {
  parentPort.postMessage({ id, extract: extractFile(source, relPath) });
});
