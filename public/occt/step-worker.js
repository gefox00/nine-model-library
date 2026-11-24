/* Classic worker: both runtime files are bundled locally by copy-occt.mjs. */
importScripts('./occt-import-js.js');
const ready = occtimportjs({ locateFile: (name) => new URL(name, self.location.href).href });
self.onmessage = async ({ data }) => {
  try {
    const triangleLimit = data.limits?.triangles;
    if (!Number.isSafeInteger(triangleLimit) || triangleLimit <= 0) throw new Error('STEPのプレビューメモリ設定を読み取れませんでした');
    const occt = await ready;
    const result = occt.ReadStepFile(new Uint8Array(data.buffer), {
      linearUnit: 'millimeter',
      linearDeflectionType: 'bounding_box_ratio',
      linearDeflection: 0.001,
      angularDeflection: 0.5,
    });
    const triangles = result.meshes?.reduce((sum, mesh) => sum + (mesh.index?.array?.length || 0) / 3, 0) || 0;
    if (triangles > triangleLimit) {
      const hard = triangleLimit >= data.hardTriangleLimit;
      const guidance = hard ? 'この上限はメモリ設定では変更できません。モデルを分割するか、Bambu Studioで開いてください。' : '「設定と連携」→「プレビューメモリ」で読み込み予算を増やしてください。';
      throw new Error(`STEPの三角形数は ${triangles.toLocaleString('ja-JP')} で、${hard ? '実装上' : '現在'}の上限 ${triangleLimit.toLocaleString('ja-JP')} を超えています。${guidance}`);
    }
    self.postMessage({ result });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
};
