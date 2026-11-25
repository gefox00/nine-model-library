import { encodeMeshResult } from './mesh-transfer.js';
import { loadSTL } from './stl.js';
import { load3MF } from './three-mf.js';
import { parseWorkerXml } from './three-mf-worker-xml.js';

self.onmessage = async ({ data: { format, buffer, limits } }) => {
  try {
    const model = format === 'stl'
      ? await loadSTL(buffer, { limits })
      : await load3MF(buffer, { limits, parseDocument: parseWorkerXml });
    const { payload, transfer } = encodeMeshResult(model);
    self.postMessage({ payload }, transfer);
  } catch (error) {
    self.postMessage({ error: { message: error.message, name: error.name, code: error.code } });
  }
};
