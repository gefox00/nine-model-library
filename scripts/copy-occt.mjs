import { copyFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const source = path.dirname(require.resolve('occt-import-js'));
const target = fileURLToPath(new URL('../public/occt/', import.meta.url));
await mkdir(target, { recursive: true });
await Promise.all(['occt-import-js.js', 'occt-import-js.wasm'].map((file) => copyFile(path.join(source, file), path.join(target, file))));
console.log('STEP runtime copied to public/occt');
