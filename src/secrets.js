'use strict';

const fs = require('fs');
const path = require('path');

const REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/;

class SecretStore {
  constructor(userDataDir, safeStorage) {
    this.file = path.join(userDataDir, 'secrets.json');
    this.safeStorage = safeStorage;
    this.values = this.load();
  }

  assertRef(ref) {
    if (!REF_PATTERN.test(ref || '')) throw new Error('secretRef 格式不正確');
  }

  encryptionAvailable() {
    return !!(this.safeStorage && typeof this.safeStorage.isEncryptionAvailable === 'function' && this.safeStorage.isEncryptionAvailable());
  }

  requireEncryption() {
    if (!this.encryptionAvailable()) throw new Error('系統安全儲存目前不可用，請改用 API key 環境變數');
  }

  load() {
    let raw;
    try { raw = fs.readFileSync(this.file, 'utf8'); } catch { return {}; } // 檔案不存在:還沒存過任何 key
    try {
      const parsed = JSON.parse(raw);
      if (parsed && parsed.version === 1 && parsed.values && typeof parsed.values === 'object' && !Array.isArray(parsed.values)) return parsed.values;
    } catch {}
    // 內容壞掉時先把原檔改名保留，否則下一次 set 會直接蓋掉，所有已存的 key 一起消失
    this.backupFile = `${this.file}.corrupt-${Date.now()}`;
    try { fs.renameSync(this.file, this.backupFile); } catch { this.backupFile = null; }
    return {};
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.tmp`;
    fs.writeFileSync(temp, JSON.stringify({ version: 1, values: this.values }, null, 2), { mode: 0o600 });
    fs.renameSync(temp, this.file);
    try { fs.chmodSync(this.file, 0o600); } catch {}
  }

  set(ref, value) {
    this.assertRef(ref);
    if (typeof value !== 'string' || !value.trim()) throw new Error('API key 不可空白');
    this.requireEncryption();
    const encrypted = this.safeStorage.encryptString(value.trim());
    this.values[ref] = encrypted.toString('base64');
    this.save();
    return this.status(ref);
  }

  get(ref) {
    this.assertRef(ref);
    const encoded = this.values[ref];
    if (!encoded) return '';
    this.requireEncryption();
    try {
      return this.safeStorage.decryptString(Buffer.from(encoded, 'base64'));
    } catch {
      throw new Error('無法解密已儲存的 API key，請清除後重新設定');
    }
  }

  clear(ref) {
    this.assertRef(ref);
    const existed = Object.prototype.hasOwnProperty.call(this.values, ref);
    if (existed) {
      delete this.values[ref];
      this.save();
    }
    return { configured: false, source: null, hint: '' };
  }

  status(ref, envName) {
    this.assertRef(ref);
    if (this.values[ref]) {
      const value = this.get(ref);
      return { configured: true, source: 'safeStorage', hint: mask(value) };
    }
    const envValue = envName && process.env[envName];
    return envValue
      ? { configured: true, source: 'environment', hint: mask(envValue) }
      : { configured: false, source: null, hint: '' };
  }
}

function mask(value) {
  const text = String(value || '');
  if (!text) return '';
  if (text.length <= 8) return `${text.slice(0, 2)}…${text.slice(-2)}`;
  return `${text.slice(0, 3)}…${text.slice(-4)}`;
}

module.exports = { SecretStore, REF_PATTERN, mask };
