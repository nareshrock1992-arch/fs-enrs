// Builds a workbook off the main thread: that thread also serves ESL events and the
// campaign tick, and a 50,000-row workbook takes over a second of CPU.
import { parentPort, workerData } from 'worker_threads';
import { buildWorkbook } from './xlsxWriter.js';

parentPort.postMessage(buildWorkbook(workerData));
