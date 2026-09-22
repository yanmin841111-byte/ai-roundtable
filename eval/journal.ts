// 實驗流水帳:每跑完一次就記一行,中斷後可以接著跑。
//
// 為什麼需要:一輪實驗要好幾個小時,中間可能被暫停(機器要做別的事)、也可能被別的改動打斷。
// 沒有流水帳就只能整輪重跑,或是手動把兩份紀錄併起來算——今天兩種都做過了。
// 每一行是一次完整的結果,所以續跑不會重複計算,也不會把不同版本的程式混在一起:
// 程式版本(commit)不一樣的紀錄會被忽略,並在畫面上說出來。
import fs from 'fs';
import path from 'path';

export interface JournalEntry {
  task: string;
  condition: string;
  protocol?: string;
  commit: string;
  // 這一次的結果(形狀與 ab.ts 的 AbRun 相同)
  run: Record<string, unknown>;
}

export function readJournal(file: string): JournalEntry[] {
  if (!file || !fs.existsSync(file)) return [];
  const out: JournalEntry[] = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (e && typeof e.task === 'string' && typeof e.condition === 'string' && /^[a-z][a-z0-9-]*$/.test(e.condition) && e.run) out.push(e);
    } catch { /* 寫到一半被中斷的最後一行:丟掉就好 */ }
  }
  return out;
}

export function appendJournal(file: string, entry: JournalEntry): void {
  if (!file) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(entry) + '\n');
}

// 這一輪還要跑幾次:同一個 commit、同一題、同一種條件的紀錄才算數
export function remaining(entries: JournalEntry[], task: string, condition: string, commit: string, runs: number): number {
  const done = entries.filter((e) => e.task === task && e.condition === condition && e.commit === commit).length;
  return Math.max(0, runs - done);
}

// 版本不同而被忽略的紀錄:要讓人知道,不能靜靜地少算
export function staleCount(entries: JournalEntry[], commit: string): number {
  return entries.filter((e) => e.commit !== commit).length;
}
