import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import manifest from '../package.json' with { type: 'json' };

const directory = fileURLToPath(new URL('../release/win-unpacked/', import.meta.url));
const current = path.join(directory, `${manifest.productName}.exe`);
const legacy = path.join(directory, 'Nine Model Library.exe');
const executable = !existsSync(current) && existsSync(legacy) ? legacy : current;
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.NINE_DATA_DIR;
delete env.NINE_TEST_MODE;
const child = spawn(executable, [], { cwd: path.dirname(executable), detached: true, stdio: 'ignore', env });
child.on('error', error => { console.error(error); process.exitCode = 1; });
child.once('spawn', () => console.log(`${path.basename(executable, '.exe')} launched: PID ${child.pid}`));
child.unref();
