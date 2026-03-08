const fs = require('fs');
const path = require('path');

const PLATFORM_TRIPLE = {
  darwin: process.arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin',
  win32: 'x86_64-pc-windows-msvc',
  linux: process.arch === 'arm64' ? 'aarch64-unknown-linux-gnu' : 'x86_64-unknown-linux-gnu',
};
const triple = PLATFORM_TRIPLE[process.platform] || 'aarch64-apple-darwin';
const name = `api-server-${triple}`;
const desktopRoot = path.resolve(__dirname, '..');
const serverDist = path.resolve(desktopRoot, '../../server/dist');
const binariesDir = path.join(desktopRoot, 'src-tauri/binaries');
const src = path.join(serverDist, name);
const dest = path.join(binariesDir, name);

if (!fs.existsSync(src)) {
  console.error(`api-server binary not found at ${src} (run server build first)`);
  process.exit(1);
}
fs.mkdirSync(binariesDir, { recursive: true });
fs.copyFileSync(src, dest);
console.log(`Copied ${name} to desktop binaries`);
