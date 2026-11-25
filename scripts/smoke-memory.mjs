import { _electron as electron } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { unzipSync, zipSync, strToU8, strFromU8 } from 'fflate';
import { fileURLToPath } from 'node:url';
import manifest from '../package.json' with { type: 'json' };

const root = fileURLToPath(new URL('../', import.meta.url));
const packaged = process.argv.includes('--packaged');
const releaseDirectory = process.argv.find(arg => arg.startsWith('--release-dir='))?.slice('--release-dir='.length) || 'release';
const executablePath = packaged ? path.resolve(root, releaseDirectory, 'win-unpacked', `${manifest.productName}.exe`)
  : path.join(root, 'node_modules/electron/dist/electron.exe');
const args = packaged ? [] : ['.'];
const out = path.join(root,'output/playwright');
await fs.mkdir(out,{recursive:true});
const testDir = await fs.mkdtemp(path.join(out,'memory-'));
const fixture = unzipSync(await fs.readFile(path.join(root, 'tests/fixtures/cube-mm.3mf')));
const modelName = Object.keys(fixture).find(name=>name.endsWith('.model'));
// A valid cube with a large XML comment tests real expanded-size limits without huge geometry.
const xml = strFromU8(fixture[modelName]);
fixture[modelName] = strToU8(xml.replace('</model>',`<!--${' '.repeat(40*1024*1024)}--></model>`));
const file = path.join(testDir,'memory-limit-cube.3mf');
await fs.writeFile(file,zipSync(fixture));
const fileWithImage = path.join(testDir, 'memory-limit-with-image.3mf');
const thumbnail = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=', 'base64');
await fs.writeFile(fileWithImage, zipSync({ ...fixture, 'Metadata/plate_1.png': thumbnail }));
const env = {...process.env,NINE_DATA_DIR:path.join(testDir,'data'),NINE_TEST_MODE:'1'};
delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS; delete env.VITE_DEV_SERVER_URL;
let app;
const findings=[];
const errors=[];
async function waitForMemoryBudget(page, expected) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const actual = await page.evaluate(() => window.nine.getState().then(state => state.settings.memoryBudgetMiB));
    if (actual === expected) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Memory setting was not persisted: expected ${expected} MiB`);
}
try {
  app=await electron.launch({executablePath,args,cwd:root,env,timeout:40000});
  const page=await app.firstWindow();
  page.on('pageerror',error=>errors.push(error.message));
  await page.waitForFunction(()=>window.nine);
  const originalBambuPath = (await page.evaluate(() => window.nine.getState())).settings.bambuPath;
  await page.evaluate(file=>window.nine.importPaths([file]),file);
  await page.getByRole('button',{name:'設定と連携',exact:true}).click();
  assert.equal(await page.getByLabel('プレビュー用メモリ予算',{exact:true}).inputValue(),'2');
  await page.getByRole('button',{name:'0.5 GiB',exact:true}).click();
  await page.getByRole('button',{name:'設定を保存',exact:true}).click();
  await waitForMemoryBudget(page, 512);
  await page.getByRole('button',{name:'設定を閉じる',exact:true}).click();
  await page.getByRole('button',{name:'モデル memory-limit-cube.3mf',exact:true}).click();
  assert.equal(await page.getByTestId('model-viewer').count(), 0);
  await page.getByRole('button', { name: '3Dプレビューを読み込む', exact: true }).click();
  await page.locator('[data-phase="error"]').waitFor({timeout:30000});
  assert.equal(await page.getByTestId('model-canvas').count(), 0);
  assert.match(await page.locator('[role="alert"]').innerText(),/32 MiB/);
  assert.match(await page.locator('[role="alert"]').innerText(),/プレビューメモリ/);
  findings.push('0.5 GiB setting rejects 40 MiB model XML at its 32 MiB limit, with exact values');
  await page.screenshot({path:path.join(out,'memory-limit-error.png')});
  await page.getByRole('button',{name:'プレビューメモリ設定',exact:true}).click();
  await page.getByRole('button',{name:'1 GiB',exact:true}).click();
  await page.getByRole('button',{name:'設定を保存',exact:true}).click();
  await waitForMemoryBudget(page, 1024);
  assert.equal(await page.locator('[data-testid="model-viewer"]').getAttribute('data-phase'),'error');
  findings.push('Saving only preserves current model and does not trigger an unexpected reload');
  await page.screenshot({path:path.join(out,'memory-settings.png')});
  await page.getByRole('checkbox', { name: '軽量モード（標準）' }).uncheck();
  await page.getByRole('button',{name:'保存して再読み込み',exact:true}).click();
  await page.locator('[data-phase="ready"]').waitFor({timeout:30000});
  assert.deepEqual(await page.locator('.dimensions b').allTextContents(),['20.00','30.00','10.00']);
  findings.push('Save-and-reload renders the same 3MF at 1 GiB without restarting the app');
  await page.screenshot({path:path.join(out,'memory-limit-recovered.png')});
  await page.evaluate(async path => {
    await window.nine.updateSettings({ lightweightPreview: true });
    await window.nine.importPaths([path]);
  }, fileWithImage);
  await page.getByRole('button', { name: 'モデル memory-limit-with-image.3mf', exact: true }).click();
  await page.getByRole('button', { name: '3Dプレビューを読み込む', exact: true }).click();
  await page.locator('[data-phase="preview"]').waitFor({ timeout: 30000 });
  await page.waitForFunction(() => document.querySelector('.preview-only img')?.naturalWidth === 1);
  assert.equal(await page.getByTestId('model-canvas').count(), 0);
  await page.getByRole('button', { name: '詳細上限で再読み込み', exact: true }).click();
  await page.locator('[data-phase="ready"]').waitFor({ timeout: 30000 });
  assert.deepEqual(await page.locator('.dimensions b').allTextContents(), ['20.00', '30.00', '10.00']);
  assert.equal(await page.evaluate(async () => (await window.nine.getState()).settings.lightweightPreview), true);
  findings.push('A 3MF above the default cap falls back to a decoded image without WebGL; explicit detail renders the exact dimensions without changing lightweight settings');
  await page.getByRole('button',{name:'設定と連携',exact:true}).click();
  await page.getByLabel('プレビュー用メモリ予算',{exact:true}).fill('0');
  assert(await page.getByRole('button',{name:'設定を保存',exact:true}).isDisabled());
  await page.getByLabel('プレビュー用メモリ予算',{exact:true}).fill('4.5');
  await page.getByRole('button',{name:'設定を保存',exact:true}).click();
  await waitForMemoryBudget(page, 4608);
  const state=await page.evaluate(()=>window.nine.getState());
  assert(state.system.totalMemoryMiB>0);
  assert.equal(state.settings.bambuPath, originalBambuPath);
  assert.equal(state.items.length,2);
  await app.close();app=null;
  app=await electron.launch({executablePath,args,cwd:root,env,timeout:40000});
  const next=await app.firstWindow();
  await next.getByRole('button',{name:'設定と連携',exact:true}).click();
  assert.equal(await next.getByLabel('プレビュー用メモリ予算',{exact:true}).inputValue(),'4.5');
  assert.equal((await next.evaluate(() => window.nine.getState())).settings.bambuPath, originalBambuPath);
  findings.push('Custom 4.5 GiB persisted across restart; model registration and optional Bambu path retained');
  assert.deepEqual(errors,[]);
  const report={passed:true,packaged,findings,errors};
  await fs.writeFile(path.join(out,packaged?'memory-packaged-result.json':'memory-result.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report,null,2));
} catch(error){
  console.error(error);process.exitCode=1;
  if(app) await (await app.firstWindow()).screenshot({path:path.join(out,'memory-failure.png')}).catch(()=>{});
} finally{if(app)await app.close();}
