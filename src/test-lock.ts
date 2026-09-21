// 測試鎖:任務開始前就存在的測試檔,在修復回合不可以被改。
//
// 為什麼需要:自動驗證讓「測試通過」變成流程的判斷依據,而讓測試通過有兩條路——
// 改實作,或改測試。模型被要求「修到通過」時,改測試是更短的那條路(放寬斷言、刪掉案例、
// 改掉期望值)。那樣一來,驗證通過只代表測試被改軟了,這道保證就是假的。
//
// 兩層處理,因為兩種成員的能力不同:
//   API 成員:檔案工具直接擋下對這些檔案的寫入(擋得住)。
//   CLI 成員:自己動檔案,工具擋不到,所以改成「照實說出來」——提示裡要求不要改,
//            真的改了就在審查提示、系統訊息與結果卡上標出來,讓人看得到。
import path from 'path';

// 常見的測試檔命名。刻意保守:寧可漏標,也不要把一般程式誤鎖成測試檔。
const TEST_NAME = /(^|[._-])(test|tests|spec)\.[a-z0-9]+$|[._-](test|spec)\.[a-z0-9]+$/i;
const TEST_DIR = new Set(['test', 'tests', '__tests__', 'spec', '__test__']);

export function isTestFile(file: string): boolean {
  const parts = file.split('/');
  if (parts.some((p) => TEST_DIR.has(p.toLowerCase()))) return true;
  return TEST_NAME.test(path.basename(file));
}

// 任務開始前就存在、而且這次被改動的測試檔。
// 新增的測試檔不算:寫新測試是好事,要擋的是「把既有的測試改軟」。
export function lockedTests(before: ReadonlyMap<string, string> | null, changed: string[] | null): string[] {
  if (!before || !changed) return [];
  return changed.filter((f) => isTestFile(f) && before.has(f));
}

// 這次改動裡有哪些測試檔(不分新舊):用來提醒審查者去看
export function changedTests(changed: string[] | null): string[] {
  return (changed || []).filter(isTestFile);
}
