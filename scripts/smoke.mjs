import { _electron as electron } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import manifest from '../package.json' with { type: 'json' };
import { zipSync, strToU8 } from 'fflate';

const root = fileURLToPath(new URL('../', import.meta.url));
const packaged = process.argv.includes('--packaged');
const releaseDirectory = process.argv.find(arg => arg.startsWith('--release-dir='))?.slice('--release-dir='.length) || 'release';
const executablePath = packaged ? path.resolve(root, releaseDirectory, 'win-unpacked', `${manifest.productName}.exe`)
  : path.join(root, 'node_modules/electron/dist/electron.exe');
const launchArgs = packaged ? [] : ['.'];
const out = path.join(root, 'output', 'playwright');
await fs.mkdir(out, { recursive: true });
const testDir = await fs.mkdtemp(path.join(out, 'smoke-'));
const watchDir = path.join(testDir, 'models');
await fs.mkdir(watchDir);
for (const name of ['cube-mm.stl', 'cube-mm.step', 'cube-mm.3mf', 'bambu-components.3mf']) {
  await fs.copyFile(path.join(root, 'tests', 'fixtures', name), path.join(watchDir, name));
}
const env = { ...process.env, NINE_DATA_DIR: path.join(testDir, 'data'), NINE_TEST_MODE: '1' };
delete env.ELECTRON_RUN_AS_NODE;
delete env.NODE_OPTIONS;
delete env.VITE_DEV_SERVER_URL;
let app;
const findings = [];
const errors = [];
try {
  app = await electron.launch({ executablePath, args: launchArgs, cwd: root, env, timeout: 40000 });
  const page = await app.firstWindow();
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if(m.type() === 'error') console.log('BROWSER ERROR',m.text()); });
  await page.getByRole('heading', { name: 'モデルの居場所をつくろう' }).waitFor();
  await page.screenshot({ path: path.join(out, 'empty-library.png') });
  const imported = await page.evaluate(dir => window.nine.importPaths([dir]), watchDir);
  assert.equal(imported.folders.length, 1);
  assert.equal(imported.items.length, 4);
  findings.push('Directory import registered all 4 fixture files and enabled watch');
  for (const name of ['cube-mm.stl', 'cube-mm.step', 'cube-mm.3mf', 'bambu-components.3mf']) {
    await page.getByRole('button', { name: `モデル ${name}`, exact: true }).click();
    await page.getByRole('button', { name: '3Dプレビューを読み込む', exact: true }).click();
    await page.locator('[data-testid="model-viewer"][data-phase="ready"]').waitFor({ timeout: 60000 });
    const dimensions = await page.locator('.dimensions b').allTextContents();
    if (name.startsWith('cube-mm')) assert.deepEqual(dimensions, ['20.00','30.00','10.00']);
    assert.equal(await page.locator('[data-testid="model-canvas"]').count(), 1);
    findings.push(`${name}: rendered, dimensions ${dimensions.join(' x ')} mm`);
    await page.screenshot({ path: path.join(out, `${name.replaceAll('.','-')}.png`) });
  }
  await page.getByRole('button', {name:'ワイヤーフレーム',exact:true}).click();
  await page.getByRole('button', {name:'上面',exact:true}).click();
  await page.getByRole('button', {name:'全体を表示 (F)',exact:true}).click();
  await page.getByRole('button', {name:'ワイヤーフレーム',exact:true}).click();
  await page.getByRole('button', {name:'斜め',exact:true}).click();
  await page.getByLabel('タグ',{exact:true}).fill('治具, テスト');
  await page.locator('.detail-section form').getByRole('button',{name:'保存'}).click();
  await page.getByLabel('メモ',{exact:true}).fill('PLA / integration test');
  await page.locator('.detail-section').filter({has:page.getByLabel('メモ',{exact:true})}).getByRole('button',{name:'保存',exact:true}).last().click();
  const selectedCard = page.getByRole('button',{name:'モデル bambu-components.3mf',exact:true});
  await selectedCard.getByRole('button',{name:'お気に入りに追加',exact:true}).click();
  await page.getByPlaceholder('ファイル名・タグで検索…').fill('治具');
  await page.waitForFunction(() => document.querySelectorAll('.model-card').length === 1);
  findings.push('Tag/note/favorite saved and tag search filtered the library');
  await page.getByPlaceholder('ファイル名・タグで検索…').fill('');
  const nextFile = path.join(watchDir, '自動登録テスト.stl');
  await fs.copyFile(path.join(watchDir,'cube-mm.stl'), nextFile);
  await page.getByRole('button',{name:'モデル 自動登録テスト.stl',exact:true}).waitFor({timeout:15000});
  await page.getByRole('button',{name:'モデル 自動登録テスト.stl',exact:true}).click();
  await page.getByRole('button', { name: '3Dプレビューを読み込む', exact: true }).click();
  await page.locator('[data-phase="ready"]').waitFor();
  await fs.unlink(nextFile);
  await page.locator('[data-phase="error"]').waitFor({timeout:15000});
  await fs.copyFile(path.join(watchDir,'cube-mm.stl'), nextFile);
  await page.locator('[data-phase="ready"]').waitFor({timeout:15000});
  findings.push('Real watcher reflected add, missing file, and restored file in the UI');
  const saved = await page.evaluate(() => window.nine.getState());
  assert.equal(saved.items.find(i => i.name === 'bambu-components.3mf').notes,'PLA / integration test');
  assert(saved.items.find(i => i.name === 'bambu-components.3mf').favorite);
  assert(saved.items.filter(i=>i.hasThumbnail).length >= 4);
  assert(saved.items.every(i=>!Object.hasOwn(i, 'thumbnail')));
  // Keep extra format coverage self-contained: ASCII STL and a sliced 3MF
  // carrying only an embedded image. Never import a developer's model library.
  const vertices = [[0, 0, 0], [50, 0, 0], [0, 30, 0], [0, 0, 60]];
  const faces = [[0, 2, 1], [0, 1, 3], [0, 3, 2], [1, 2, 3]];
  const facets = faces.map(indices => {
    const [a, b, c] = indices.map(index => vertices[index]);
    const u = b.map((value, axis) => value - a[axis]);
    const v = c.map((value, axis) => value - a[axis]);
    const cross = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const length = Math.hypot(...cross);
    return `facet normal ${cross.map(value => value / length).join(' ')}\nouter loop\n${[a, b, c].map(vertex => `vertex ${vertex.join(' ')}`).join('\n')}\nendloop\nendfacet`;
  });
  const asciiFile = path.join(testDir, 'ascii-tetra.stl');
  await fs.writeFile(asciiFile, `solid generated_tetrahedron\n${facets.join('\n')}\nendsolid generated_tetrahedron\n`);
  const imageFile = path.join(testDir, 'image-only.3mf');
  const thumbnail = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=', 'base64');
  await fs.writeFile(imageFile, zipSync({
    '3D/3dmodel.model': strToU8('<?xml version="1.0"?><model xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" unit="millimeter"><resources/><build/></model>'),
    'Metadata/plate_1.png': thumbnail,
  }));
  await page.evaluate(paths => window.nine.importPaths(paths), [asciiFile, imageFile]);
  for (const file of [asciiFile, imageFile]) {
    const name = path.basename(file);
    await page.getByRole('button',{name:`モデル ${name}`,exact:true}).click();
    await page.getByRole('button', { name: '3Dプレビューを読み込む', exact: true }).click();
    await page.waitForFunction(() => ['ready','preview','error'].includes(document.querySelector('[data-testid="model-viewer"]')?.dataset.phase),null,{timeout:90000});
    const phase = await page.locator('[data-testid="model-viewer"]').getAttribute('data-phase');
    assert.equal(phase, file === asciiFile ? 'ready' : 'preview', `${name}: unexpected viewer state`);
    if (file === asciiFile) assert.deepEqual(await page.locator('.dimensions b').allTextContents(), ['50.00', '30.00', '60.00']);
    else assert.deepEqual(await page.locator('.dimensions b').allTextContents(), ['—', '—', '—']);
    findings.push(`Generated fixture ${phase === 'preview' ? 'has no mesh; embedded preview displayed without invented dimensions' : 'rendered in 3D'}: ${name}`);
    await page.screenshot({path:path.join(out,file === asciiFile ? 'ascii-tetra.png' : 'image-only-3mf.png')});
  }
  const configuredBambu = (await page.evaluate(() => window.nine.getState())).settings.bambuPath;
  const studio = await page.evaluate(() => window.nine.getBambuPrintStatus());
  if (configuredBambu) {
    assert.equal(studio.available, true);
    assert.equal(studio.capabilities.printerConfirmationInStudio, true);
    assert.match(studio.version, /\d+\.\d+/);
  }
  await page.getByRole('button',{name:'設定と連携',exact:true}).click();
  const displayedBambu = await page.locator('.settings-section').filter({ has: page.getByRole('heading', { name: 'Bambu Studio', exact: true }) }).locator('.path-field').innerText();
  if (configuredBambu) assert.equal(displayedBambu, configuredBambu);
  else assert.match(displayedBambu, /未検出/);
  await page.screenshot({path:path.join(out,'settings.png')});
  await page.getByRole('button',{name:'設定を閉じる',exact:true}).click();
  findings.push(configuredBambu ? 'Configured Bambu Studio path appears in settings (installation is optional)' : 'Missing Bambu Studio is shown as unconfigured; no installation is required');
  assert.deepEqual(errors,[]);
  await app.close(); app=null;
  app=await electron.launch({executablePath,args:launchArgs,cwd:root,env,timeout:40000});
  const restarted=await app.firstWindow();
  await restarted.waitForFunction(()=>window.nine);
  const restored=await restarted.evaluate(()=>window.nine.getState());
  assert(restored.items.find(i=>i.name==='bambu-components.3mf').favorite);
  assert.equal(restored.folders.length,1);
  assert.equal(restored.settings.bambuPath, configuredBambu);
  findings.push('Library, favorite, notes and watch folder survived a full app restart');
  const bulk = await fs.mkdtemp(path.join(testDir, 'paging-'));
  const models = Array.from({ length: 96 }, (_, index) => path.join(bulk, `paging-${String(index).padStart(3, '0')}.stl`));
  await Promise.all(models.map(file => fs.copyFile(path.join(watchDir, 'cube-mm.stl'), file)));
  await restarted.evaluate(files => window.nine.importPaths(files), models);
  const cards = restarted.locator('.model-card');
  await restarted.waitForFunction(() => document.querySelectorAll('.model-card').length === 48);
  const firstPage = await cards.first().getAttribute('aria-label');
  await restarted.getByRole('button', { name: '次のページ', exact: true }).click();
  assert.equal(await cards.count(), 48);
  assert.notEqual(await cards.first().getAttribute('aria-label'), firstPage);
  await cards.first().click();
  assert.equal(await restarted.getByTestId('model-canvas').count(), 0);
  assert.equal(await restarted.getByRole('button', { name: '3Dプレビューを読み込む', exact: true }).count(), 1);
  findings.push('96 extra models are paginated at 48 mounted cards; selection does not create a WebGL canvas in lightweight mode');
  const report={passed:true,packaged,findings,errors,testDir};
  await fs.writeFile(path.join(out,packaged?'packaged-result.json':'smoke-result.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report,null,2));
} catch(error) {
  console.error(error);
  if(app){const page=await app.firstWindow().catch(()=>null);if(page) await page.screenshot({path:path.join(out,'failure.png')}).catch(()=>{});}
  process.exitCode=1;
} finally { if(app) await app.close(); }
