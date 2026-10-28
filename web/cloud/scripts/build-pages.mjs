import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const python = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const build = spawnSync(python, [resolve(root, 'scripts/build-pages.py')], { cwd: root, stdio: 'inherit' });
if (build.status !== 0) process.exit(build.status || 1);