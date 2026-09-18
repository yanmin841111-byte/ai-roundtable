// 交叉審查:誰審誰、審查者怎麼看到改動、審查的結論
import path from 'path';
import { knownCapability } from '../adapters';
import { hasMarker } from '../shared';
import { attachmentCapabilities } from '../attachments';
import type { AgentConfig, ReviewVerdict } from '../ipc-types';
import type { Adapter } from '../adapters/types';
import type { ExecReport, ReviewPair } from './types';

export const NO_ISSUES = 'NO_ISSUES';

// ---------- 審查配對 ----------
// 兩份以上成果:每人審查下一位(環狀)。
// 只有一份:從其他啟用成員裡挑一位(優先有執行成果的),讓單人執行也有品質關卡。
// 整場只剩一名啟用成員時回空陣列,由呼叫端提示並略過。
// 「誰有資格審查 targetId 的改動」——合格條件只有一條:不是改動的本人。
//
// 這個判定是唯一的真相來源,執行前的工具閘門與執行後的 markUnreviewed 都用它。
// 兩邊各寫一套的話,就會出現「事前開了寫入工具、事後卻沒有人審」的縫隙,
// 而那正是使用者最不可能自己發現的一種失敗:畫面看起來跟順利跑完一模一樣。
export function reviewerCandidates(agents: AgentConfig[] | null | undefined, targetId: string): AgentConfig[] {
  return (agents || []).filter((a) => a && a.id !== targetId);
}

// 這次改動有沒有人能審。執行前只知道「誰會執行」,還沒有 report,所以用 id 判斷。
export function hasQualifiedReviewer(agents: AgentConfig[] | null | undefined, targetId: string): boolean {
  return reviewerCandidates(agents, targetId).length > 0;
}

export function pickReviewPairs(agents: AgentConfig[] | null | undefined, reports: ExecReport[]): ReviewPair[] {
  if (!Array.isArray(reports) || reports.length === 0) return [];
  if (reports.length >= 2) {
    return reports.map((r, i) => ({ reviewer: r.agent, target: reports[(i + 1) % reports.length] }));
  }
  const target = reports[0];
  const executed = new Set(reports.map((r) => r.agent.id));
  // 與 hasQualifiedReviewer 共用同一組候選人;這裡只是再挑出優先順序
  // (先找也執行過的人,他讀過工作內容,審起來更有依據)
  const candidates = reviewerCandidates(agents, target.agent.id);
  const reviewer = candidates.find((a) => executed.has(a.id)) || candidates[0];
  return reviewer ? [{ reviewer, target }] : [];
}

// ---------- 審查者看得到改動的方式 ----------
export const REVIEW_FILES_MAX = 20;
export const REVIEW_INLINE_FILES = 6;
export const REVIEW_INLINE_FILE_CHARS = 6000;
export const REVIEW_INLINE_TOTAL_CHARS = 20000;
// 「檔案數 × 回報長度」的上限,約 0.1 秒內掃得完
export const MENTION_SCAN_BUDGET = 50_000_000;

//   open   本身就能依路徑讀檔(Claude Code、Codex、Cursor 宣告了 filePath)
//   tool   OpenAI 相容端點且範本開了檔案工具:給唯讀的 read_file,內容也照樣附上
//   inline 兩者皆否:把改動檔案目前的內容直接附在提示詞裡
// 依能力分,不依品牌分:模型換版本很快,能力才是這一步真正需要知道的事。
export function reviewAccess(adapter: Adapter | null | undefined, reviewer: AgentConfig): 'open' | 'tool' | 'inline' {
  if (!adapter) return 'inline';
  if (attachmentCapabilities(adapter).modes.has('filePath')) return 'open';
  // OpenAI 相容 adapter 的 supportsEdit 就等於「範本明確開啟了檔案工具,端點支援工具呼叫」。
  // 已知這個模型不能呼叫工具就不送:那個請求一定被拒絕,只是多等一輪再重送
  if (adapter.type === 'openai' && adapter.supportsEdit) return knownCapability(reviewer)?.tools === false ? 'inline' : 'tool';
  return 'inline';
}

// 同一個 adapter,拿掉「收圖片」這項能力。已知不能看圖的模型用它:以前圖片照樣送出、被端點拒絕,
// 再靠重送拿掉——每次多等一輪,附件區塊還跟它說「圖片已附上」。
export function withoutImages(adapter: Adapter | null): Adapter | null {
  if (!adapter) return adapter;
  const { modes, needCwd } = attachmentCapabilities(adapter);
  if (!modes.has('imageInline')) return adapter;
  return { ...adapter, capabilities: { attachments: [...modes].filter((m) => m !== 'imageInline'), attachmentsNeedCwd: needCwd } };
}

// 審查的結論。流程(要不要進修復回合、算不算審查過)與介面的徽章都用這一個判斷,兩邊不會各說各話
export function reviewVerdict(text: string | null | undefined, error: string | null | undefined): ReviewVerdict {
  if (error || !(text || '').trim()) return 'failed';
  return hasMarker(text, NO_ISSUES) ? 'pass' : 'issues';
}

// 這位成員自己用工具改過的檔案(精確)
export function ownPaths(report: ExecReport): Set<string> {
  return new Set((report.toolEvents || [])
    .filter((e) => e.ok !== false && e.tool !== 'read_file' && e.path)
    .map((e) => String(e.path)));
}

// CLI 被審者要審的檔案:自己的工具紀錄(通常沒有)+ 工作目錄的差異。附內容有數量上限,
// 排前面的才看得到,所以任務或回報裡提到的排前面。其他成員工具紀錄裡的檔案不排除:
// CLI 成員可能也改了同一個檔案,排除掉就會把它的改動藏起來。
// 回傳完整清單;超過 REVIEW_FILES_MAX 的部分由呼叫端截掉並註明還有幾個。
export function reviewFiles(target: ExecReport, changed: string[] | null): string[] {
  const own = ownPaths(target);
  const rest = (changed || []).filter((f) => !own.has(f));
  const said = `${target.task}\n${target.report}`;
  // 找「提到的檔案」是在主程序上同步做字串搜尋:成員一口氣產生十萬個檔案(例如 clone 一個 repo)
  // 又寫了長回報時,會把介面卡住好幾秒。超過工作量上限就不排序,照路徑順序列。
  if (rest.length * said.length > MENTION_SCAN_BUDGET) return [...own, ...rest];
  const hit = new Set(rest.filter((f) => said.includes(f) || (path.basename(f).length >= 3 && said.includes(path.basename(f)))));
  return [...own, ...rest.filter((f) => hit.has(f)), ...rest.filter((f) => !hit.has(f))];
}
