import { abortIfNeeded } from './common.js';
import { decodeMeshResult } from './mesh-transfer.js';

export async function loadMeshInWorker(format, buffer, { signal, limits, ownsBuffer }) {
  abortIfNeeded(signal);
  const worker = new Worker(new URL('./mesh-worker.js', import.meta.url), { type: 'module' });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('形状の読み込みが180秒を超えました。モデルを分割して試してください。')), 180_000);
    const onAbort = () => finish(new DOMException('読み込みをキャンセルしました', 'AbortError'));
    function finish(error, result) {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      worker.onmessage = worker.onerror = worker.onmessageerror = null;
      worker.terminate();
      if (error) reject(error);
      else resolve(result);
    }

    signal?.addEventListener('abort', onAbort, { once: true });
    worker.onerror = (event) => finish(new Error(event.message || '形状の読み込み処理を起動できませんでした'));
    worker.onmessageerror = () => finish(new Error('形状の読み込み結果を受け取れませんでした'));
    worker.onmessage = ({ data }) => {
      if (data.error) {
        const { message, name, code } = data.error;
        return finish(Object.assign(new Error(message), { name, code }));
      }
      try { finish(null, decodeMeshResult(data.payload)); }
      catch (error) { finish(error); }
    };

    try {
      const transferred = ownsBuffer ? buffer : buffer.slice(0);
      worker.postMessage({ format, buffer: transferred, limits }, [transferred]);
    } catch (error) {
      finish(error);
    }
  });
}
