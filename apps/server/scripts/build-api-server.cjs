const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const PLATFORM_TRIPLE = {
  darwin: process.arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin',
  win32: 'x86_64-pc-windows-msvc',
  linux: process.arch === 'arm64' ? 'aarch64-unknown-linux-gnu' : 'x86_64-unknown-linux-gnu',
};
const triple = PLATFORM_TRIPLE[process.platform] || 'aarch64-apple-darwin';
const serverRoot = path.resolve(__dirname, '..');
const distDir = path.join(serverRoot, 'dist');
const desktopBinaries = path.resolve(serverRoot, '../../desktop/src-tauri/binaries');
const name = `api-server-${triple}`;
const outfile = path.join(distDir, name);

fs.mkdirSync(distDir, { recursive: true });

const result = spawnSync(
  'bun',
  ['build', './src/index.ts', '--target', 'node', '--outfile', outfile],
  { stdio: 'inherit', cwd: serverRoot, shell: true }
);
if (result.status !== 0) process.exit(result.status ?? 1);

fs.mkdirSync(desktopBinaries, { recursive: true });
fs.copyFileSync(outfile, path.join(desktopBinaries, name));
process.exit(0);
