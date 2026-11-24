const formats = require('../shared/formats.json');

async function chooseRelinkModel(library, dialog, mainWindow, id) {
  const source = await library.captureRelinkSource(id);
  const format = formats.find(item => item.id === source.format);
  if (!format) throw new Error('再紐付けに対応していない形式です');
  const choice = await dialog.showOpenDialog(mainWindow, {
    title: '移動先のファイルを選択',
    properties: ['openFile'],
    filters: [{ name: format.label, extensions: format.extensions }],
  });
  if (choice.canceled || !choice.filePaths.length) return null;
  const file = choice.filePaths[0];
  const target = await library.inspectRelinkTarget(id, file, source);
  if (target.existing) {
    const decision = await dialog.showMessageBox(mainWindow, {
      type: 'question',
      title: '登録済みの移動先に再紐付け',
      message: `「${source.name}」を、ライブラリに登録済みの移動先へ再紐付けしますか？`,
      detail: '元の登録ID・お気に入り・タグ・メモ・プリセットを引き継ぎます。移動先の重複登録を整理し、ファイルはそのまま残します。',
      buttons: ['キャンセル', '再紐付け'], defaultId: 0, cancelId: 0, noLink: true,
    });
    if (decision.response !== 1) return null;
  }
  return library.relinkModel(id, file, source, target);
}

module.exports = { chooseRelinkModel };
