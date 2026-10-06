import { existsSync, watch } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const rustDir = fileURLToPath(new URL('..', import.meta.url));
const webDir = resolve(rustDir, '../web');
const cargoBin = join(homedir(), '.cargo', 'bin');
const env = { ...process.env, PATH: cargoBin + delimiter + (process.env.PATH ?? '') };
const action = process.argv[2] ?? 'dev';
const windows = process.platform === 'win32';
const executable = name => {
  const local = join(cargoBin, name + (windows ? '.exe' : ''));
  return existsSync(local) ? local : name;
};

function run(command, args, cwd = rustDir) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: 'inherit', windowsHide: true });
    child.once('error', error => reject(new Error(`${command}: ${error.message}`)));
    child.once('exit', code => code === 0 ? resolveRun() : reject(new Error(`${command} exited with ${code}`)));
  });
}

const wasm = release => run(executable('wasm-pack'), [
  'build', 'crates/wasm', '--target', 'web', '--out-dir', '../../pkg/wasm',
  release ? '--release' : '--dev', '--no-opt',
]);
const vite = (...args) => run(process.execPath, [join(webDir, 'node_modules/vite/bin/vite.js'), ...args], webDir);

async function main() {
  if (action === 'wasm') return wasm(false);
  if (action === 'check') {
    await run(executable('cargo'), ['fmt', '--all', '--', '--check']);
    await run(executable('cargo'), ['clippy', '--workspace', '--all-targets', '--', '-D', 'warnings']);
    await run(executable('cargo'), ['check', '--workspace', '--target', 'wasm32-unknown-unknown']);
    return;
  }
  if (action === 'build') {
    await wasm(true);
    await vite('build', '--mode', 'terrainbench');
    console.log(`Terrain bench: ${join(rustDir, 'out/browser/terrainbench.html')}`);
    return;
  }
  if (action !== 'dev') throw new Error('Usage: terrain.mjs dev|wasm|build|check');
  await wasm(false);
  let timer, building = false, pending = false;
  async function rebuild() {
    if (building) { pending = true; return; }
    building = true;
    try { await wasm(false); }
    catch (error) { console.error(error.message); }
    finally {
      building = false;
      if (pending) { pending = false; void rebuild(); }
    }
  }
  const schedule = () => { clearTimeout(timer); timer = setTimeout(() => void rebuild(), 250); };
  const crateWatch = watch(join(rustDir, 'crates'), { recursive: true }, (_event, file) => {
    if (file && /\.(rs|toml)$/.test(String(file))) schedule();
  });
  const manifestWatch = watch(join(rustDir, 'Cargo.toml'), schedule);
  console.log('Terrain bench: http://localhost:5173/terrainbench.html · Rust auto-rebuild enabled');
  try { await vite('--mode', 'terrainbench', '--host', '127.0.0.1'); }
  finally { clearTimeout(timer); crateWatch.close(); manifestWatch.close(); }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
