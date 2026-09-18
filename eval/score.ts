// 評測的計分與結果檔。刻意跟執行分開:計分規則可以單獨測,結果檔的形狀也在這裡定死——
// 結果檔會被分享、提交到 repo,只能有數字,不能夾帶任何對話內容或本機路徑。
import type { EvalCase, Expected } from './cases';

// 一次審查的結果(從 app 裡取出的,只留判定需要的欄位)
export interface RunOutcome {
  // 審查者宣告沒問題(用產品同一個判斷 hasMarker(text, 'NO_ISSUES'))
  passed: boolean;
  // 流程實際進了修復回合
  repaired: boolean;
  // 審查者這回合自己打開了題目裡的檔案(工具或 CLI 讀檔);附在提示詞裡的內容不算
  readFile: boolean;
  // 審查回合失敗(逾時、端點錯誤、沒有輸出):不計入分數,另外統計
  error: boolean;
}

export interface CaseScore {
  expected: Expected;
  runs: number;
  correct: number;
  errors: number;
  readFile: number;
}

export interface EvalResult {
  schema: 1;
  date: string;
  app: { version: string; commit: string };
  reviewer: { cli: string; model: string };
  runsPerCase: number;
  cases: Record<string, CaseScore>;
  total: { correct: number; scored: number; errors: number };
}

// 判對:該抓的抓到(沒有宣告沒問題),不該抓的放行
export function judged(expected: Expected, run: RunOutcome): boolean {
  return expected === 'issues' ? !run.passed : run.passed;
}

export function scoreCase(c: EvalCase, runs: RunOutcome[]): CaseScore {
  const ok = runs.filter((r) => !r.error);
  return {
    expected: c.expected,
    runs: runs.length,
    correct: ok.filter((r) => judged(c.expected, r)).length,
    errors: runs.length - ok.length,
    readFile: ok.filter((r) => r.readFile).length,
  };
}

export function buildResult(meta: { date: string; version: string; commit: string; cli: string; model: string; runsPerCase: number }, scores: Record<string, CaseScore>): EvalResult {
  const list = Object.values(scores);
  return {
    schema: 1,
    date: meta.date,
    app: { version: meta.version, commit: meta.commit },
    reviewer: { cli: meta.cli, model: meta.model },
    runsPerCase: meta.runsPerCase,
    cases: scores,
    total: {
      correct: list.reduce((n, s) => n + s.correct, 0),
      scored: list.reduce((n, s) => n + s.runs - s.errors, 0),
      errors: list.reduce((n, s) => n + s.errors, 0),
    },
  };
}

// 結果檔名:日期 + 模型,模型名稱裡的 / 與 : 換成 -
export function resultFileName(r: EvalResult): string {
  const slug = `${r.reviewer.cli}-${r.reviewer.model || 'default'}`.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return `${r.date}-${slug}.json`;
}
