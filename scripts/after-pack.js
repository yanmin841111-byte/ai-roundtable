// electron-builder 的 afterPack 鉤子:沒有 Apple 開發者憑證時,用 ad-hoc 簽章重簽整個 app。
//
// 為什麼需要:electron-builder 在 identity 為 null 時完全跳過簽章,但 Electron 本身的執行檔
// 帶著 Electron 官方的 ad-hoc 簽章,加進我們的 app.asar 之後那份簽章就對不上了
// (codesign 會報 "code has no resources but signature indicates they must be present")。
// Apple Silicon 的 macOS 拒絕執行簽章無效的 arm64 程式,使用者下載後會直接打不開。
// ad-hoc 簽章(identity 為 "-")不需要憑證;Gatekeeper 仍會警告「無法驗證開發者」,
// 但使用者可以用右鍵 → 打開,或在「隱私權與安全性」允許。
'use strict';
const { execFileSync } = require('child_process');
const path = require('path');

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const appName = `${context.packager.appInfo.productFilename}.app`;
  const appPath = path.join(context.appOutDir, appName);
  execFileSync('xattr', ['-cr', appPath], { stdio: 'inherit' });
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' });
  execFileSync('codesign', ['--verify', '--deep', '--strict', appPath], { stdio: 'inherit' });
  console.log(`  • ad-hoc signed ${appName}`);
};
