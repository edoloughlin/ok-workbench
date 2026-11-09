import { parentPort, workerData } from 'node:worker_threads';
import { extractWebText } from './web-fetch-text.mjs';

try {
  parentPort.postMessage(extractWebText(workerData.bytes, workerData.contentType, workerData.charset, workerData.maxChars));
} catch {
  parentPort.postMessage({ error: 'EXTRACTION_ERROR' });
}
