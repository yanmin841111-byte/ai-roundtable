// 跑隱藏測試:在獨立的 node 行程裡載入工作目錄裡的模組,逐項計分。
// 模型寫的程式可能無窮迴圈或直接讓行程崩潰,所以一律開子行程、設逾時。
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import type { AbTask } from './ab-tasks';

export interface TestScore {
  pass: number;
  total: number;
  failedTests?: string[];
  // 測試本身沒跑完(逾時、行程崩潰):這種情況 pass 以 0 計
  error?: string;
  // 全部失敗時常常不是邏輯錯,而是檔案沒寫出來或載不起來:分開記,才不會把工具操作失手當成解題能力
  missing?: boolean;
  loadError?: string;
}

// 每一項獨立計分:載入失敗也只是讓每一項各自失敗,總數照算
export function runHiddenTests(workDir: string, task: AbTask, timeoutMs = 15000, includeFailures = false): TestScore {
  const entry = path.join(workDir, task.entry);
  const expectedTotal = (task.tests.match(/^t\(/gm) || []).length;
  const failures = (ids: string[] = Array.from({ length: expectedTotal }, (_, index) => String(index))) => includeFailures ? { failedTests: ids } : {};
  const script = [
    "const assert = require('assert');",
    "const fs = require('fs');",
    `const ENTRY = ${JSON.stringify(entry)};`,
    `const M = () => require(${JSON.stringify(entry)});`,
    'let pass = 0, total = 0, loadError = null; const failedTests = [];',
    'try { M(); } catch (e) { loadError = String((e && e.message) || e).split("\\n")[0].slice(0, 200); }',
    'const t = (name, fn) => { const id = String(total++); try { fn(); pass++; } catch { failedTests.push(id); } };',
    // 載不起來就一分都不給。以前是照樣把題目跑完,而「格式錯誤要丟 Error」那幾題會白送分:
    // 模組本身載入就爆掉,assert.throws 一樣算過。實測過一次 5/23,其實那個檔案一行都跑不動。
    'if (!loadError) {',
    task.tests,
    '}',
    'process.stdout.write(JSON.stringify({ pass, total, loadError, failedTests }));',
  ].join('\n');
  if (!fs.existsSync(entry)) return { pass: 0, total: expectedTotal, missing: true, ...failures() };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-ab-test-'));
  const file = path.join(dir, 'hidden.test.js');
  fs.writeFileSync(file, script);
  try {
    const r = spawnSync(process.execPath, [file], { cwd: workDir, timeout: timeoutMs, encoding: 'utf8' });
    const total = (task.tests.match(/^t\(/gm) || []).length;
    if (r.error || r.status !== 0) return { pass: 0, total, error: r.error ? String(r.error.message) : `exit ${r.status}`, ...failures() };
    try {
      const out = JSON.parse(r.stdout || '{}');
      return { pass: Number(out.pass) || 0, total: Number(out.total) || total, ...(out.loadError ? { loadError: out.loadError } : {}), ...failures(out.loadError ? undefined : out.failedTests) };
    } catch {
      return { pass: 0, total, error: 'Invalid test output', ...failures() };
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// 把一組檔案寫進新的暫存目錄(驗證參考解與錯解用)
export function materialize(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-ab-files-'));
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }
  return dir;
}
