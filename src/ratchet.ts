// 棘輪:任何一次改動都不可以讓已經通過的關卡變成不通過。
//
// 為什麼需要:實驗 7(eval/EXPERIMENTS.md)的主指標沒有差別,但變異被放大了——圓桌組
// 「有改善」6/16、「大破壞」6/16,單人組各 3/16。兩端同時變成兩倍,中間的「原地不動」變少。
// 那一輪的結論寫著:「最後一次改動之後沒有守門員。實驗裡有好幾次是修復回合把檔案弄壞的,
// 而複查只能報告它壞了,沒有人把它收回去。」
//
// 棘輪就是那個守門員。它不試圖讓模型變準,它只砍掉分布的下半邊:
// 改好了就留下,改壞了就收回去,結果只會往一個方向走。多個候選 + 單向過濾,
// 這是 best-of-N 的形狀,也是多花算力唯一穩定換得到東西的方式。
//
// 比較的單位是「關卡向量」,每一項都是 app 自己跑出來的布林值,沒有任何模型的判斷:
//   syntax          這次改到的檔案載不載得起來(verify.ts)
//   gate            使用者設定的驗證指令,一行一道(verify.ts)
//   counterexample  審查者舉出、而且 app 確認過真的會失敗的反例(counterexample.ts)
//
// 反例那一項是這裡的關鍵。專案的驗證指令是一顆粗粒度的布林值——「3 個測試沒過」和
// 「10 個測試沒過」都只是 false,退步看不出來。反例把退步拆成一條一條看得見的關卡,
// 所以改造 1 和改造 2 是同一件事的兩半:沒有反例,棘輪量不到細的退步;沒有棘輪,
// 反例只是又一份沒有人執行的意見。
//
// 只比兩邊都有的關卡。一邊有、一邊沒有的(例如前一道失敗所以後面幾道根本沒跑)是「不知道」,
// 不是「沒過」——把不知道當成沒過會憑空造出退步,然後回退掉其實沒問題的成果。
import type { VerifyResult } from './verify';
import type { CounterexampleRun } from './counterexample';
import { classifyConfirmation } from './counterexample';
import { tx } from './text';
import type { TextLocale } from './text';

export type GateKind = 'syntax' | 'gate' | 'counterexample';

// 關卡的證據強度。原則是:共享的東西越能被獨立驗證,權重越高。
//
//   owned      使用者自己擁有的:語法檢查、「設定 → 驗證指令」裡的那幾道。
//              這些是人寫的、代表這個專案真正的驗收標準,退步就是退步。
//   confirmed  這次審查舉出、而且 app 當場跑過確認真的會失敗的反例。
//              它針對的是現在這份程式,剛剛才被證實過。
//   inherited  語料庫裡從過去任務累積下來的反例(見 corpus.ts)。
//              它一樣是可執行的,但它是某位審查者在某個時刻對「應該怎樣」的主張,
//              可能測錯了需求,也可能把當時的錯誤行為固化下來。而且這次的任務
//              完全可能就是要改掉那個行為。所以它只報告,不單獨觸發回退——
//              否則一條舊的錯誤主張就能把一次正確的改動整個收回去。
export type GateWeight = 'owned' | 'confirmed' | 'inherited';

export interface GateEntry {
  kind: GateKind;
  // 兩個狀態之間對得起來的識別字:檔案路徑、指令原文、反例 id
  key: string;
  // 給人看的名字
  label: string;
  weight: GateWeight;
  ok: boolean;
}

export interface GateState {
  entries: GateEntry[];
}

export interface GateChange {
  kind: GateKind;
  key: string;
  label: string;
  weight: GateWeight;
}

export interface GateComparison {
  regressed: GateChange[];
  improved: GateChange[];
  // 只有一邊量到的關卡:照實留著,訊息裡要講「這幾項無法比較」,不當成任何一種結論
  incomparable: GateChange[];
  verdict: 'regressed' | 'improved' | 'same';
}

// 從自動驗證的結果取出關卡。
//
// 語法檢查只看 checkedFiles:沒被檢查的檔案(副檔名不支援、超過上限、讀不到)狀態是不知道。
// 驗證指令只看真的跑過的那幾道:第一道沒過就停,後面那些在 skippedCommands 裡,同樣是不知道。
export function gatesFromVerify(verify: VerifyResult | null | undefined, kinds: GateKind[] = ['syntax', 'gate']): GateEntry[] {
  if (!verify || !verify.ran) return [];
  const entries: GateEntry[] = [];
  if (kinds.includes('syntax')) {
    const bad = new Set(verify.syntax.map((item) => item.file));
    for (const file of verify.checkedFiles || []) {
      entries.push({ kind: 'syntax', key: file, label: file, weight: 'owned', ok: !bad.has(file) });
    }
  }
  if (kinds.includes('gate')) {
    for (const gate of verify.gates || []) {
      entries.push({ kind: 'gate', key: gate.command, label: gate.command, weight: 'owned', ok: gate.ok });
    }
  }
  return entries;
}

// 跑不成的反例不進關卡:它既不算問題確認了,也不算修好了。
// 語料庫來的(id 以 corpus- 開頭)權重較低,理由見 GateWeight。
export function gatesFromCounterexamples(runs: CounterexampleRun[] | null | undefined): GateEntry[] {
  return (runs || [])
    .filter((run) => classifyConfirmation(run) !== 'unusable')
    .map((run) => ({
      kind: 'counterexample' as const,
      key: run.id,
      label: run.title || run.id,
      weight: run.id.startsWith('corpus-') ? 'inherited' as const : 'confirmed' as const,
      ok: run.passed,
    }));
}

export function gateState(verify: VerifyResult | null | undefined, runs?: CounterexampleRun[] | null, kinds?: GateKind[]): GateState {
  return { entries: [...gatesFromVerify(verify, kinds), ...gatesFromCounterexamples(runs)] };
}

// 會觸發回退的退步:使用者自己的關卡,加上這次剛確認過的反例。
// 語料庫的舊主張只報告,不單獨決定要不要收回這次的成果。
export function blocking(changes: GateChange[]): GateChange[] {
  return changes.filter((change) => change.weight !== 'inherited');
}

// 兩個狀態的比較。只看兩邊都有的 key;true → false 是退步,false → true 是改善。
export function compareGates(before: GateState | null | undefined, after: GateState | null | undefined): GateComparison {
  const regressed: GateChange[] = [];
  const improved: GateChange[] = [];
  const incomparable: GateChange[] = [];
  const beforeMap = new Map((before?.entries || []).map((e) => [`${e.kind}:${e.key}`, e]));
  const afterMap = new Map((after?.entries || []).map((e) => [`${e.kind}:${e.key}`, e]));
  for (const [id, entry] of afterMap) {
    const was = beforeMap.get(id);
    const change = { kind: entry.kind, key: entry.key, label: entry.label, weight: entry.weight };
    if (!was) { incomparable.push(change); continue; }
    if (was.ok && !entry.ok) regressed.push(change);
    else if (!was.ok && entry.ok) improved.push(change);
  }
  // 之前量得到、現在量不到的也算無法比較:不能因為看不到就當成通過
  for (const [id, entry] of beforeMap) {
    if (!afterMap.has(id)) incomparable.push({ kind: entry.kind, key: entry.key, label: entry.label, weight: entry.weight });
  }
  return {
    regressed,
    improved,
    incomparable,
    // verdict 只看會觸發回退的那些。語料庫的退步照樣留在 regressed 裡給介面顯示,
    // 但它不會讓 verdict 變成 'regressed' ——不然一條舊主張就能收回一次正確的改動。
    verdict: blocking(regressed).length ? 'regressed' : improved.length ? 'improved' : 'same',
  };
}

// 棘輪的決定:要不要回退,回退到哪裡。
//
//   none    沒有任何關卡退步:留著。
//   repair  只有修復回合造成的退步,而執行階段的狀態是可以回去的:只收回修復,
//           保留執行階段做對的部分(實驗 7 裡 forth-fix 圓桌有幾次就是這個形狀)。
//   task    退步在執行階段就發生了,或執行階段的狀態本身也比任務開始前糟:整段收回。
//
// 分開兩層比較是有意義的。只比「執行後 vs 修復後」會漏掉 poker-fix 單人那種情況:
// 執行階段就把 35/39 打成 1/39,修復沒有讓它更糟,於是舊的判斷說「不用回退」——
// 但相對使用者按下送出之前,那是一次純粹的破壞。基準線就是為了看見這件事。
export interface RatchetDecision {
  scope: 'none' | 'repair' | 'task';
  // 為什麼:給系統訊息與結果卡用,照實說是哪幾道關卡退步的
  reason: 'clean' | 'repair-regressed' | 'execute-regressed';
  fromBaseline: GateComparison | null;
  fromExecute: GateComparison | null;
}

export function decideRatchet({ baseline, execute, afterFix, canRevertRepair = true }: {
  baseline?: GateState | null;
  execute?: GateState | null;
  afterFix?: GateState | null;
  // 沒有修復回合的快照時不能只收回修復,只能整段回退或不回退
  canRevertRepair?: boolean;
}): RatchetDecision {
  const latest = afterFix || execute || null;
  const fromExecute = afterFix && execute ? compareGates(execute, afterFix) : null;
  const fromBaseline = baseline && latest ? compareGates(baseline, latest) : null;

  // 先看修復有沒有把執行階段做對的東西弄壞。這一層有專屬的解法——只收回修復——
  // 比整段回退保留得更多,所以要先判。
  if (fromExecute && fromExecute.verdict === 'regressed') {
    // 收回修復之後會回到執行階段的狀態;如果那個狀態相對基準線本來就是退步的,收回修復不夠
    const executeVsBaseline = baseline && execute ? compareGates(baseline, execute) : null;
    if (canRevertRepair && (!executeVsBaseline || executeVsBaseline.verdict !== 'regressed')) {
      return { scope: 'repair', reason: 'repair-regressed', fromBaseline, fromExecute };
    }
    return { scope: 'task', reason: 'execute-regressed', fromBaseline, fromExecute };
  }

  // 修復沒有弄壞任何東西,但整體相對任務開始前是退步的:執行階段就壞了,整段收回
  if (fromBaseline && fromBaseline.verdict === 'regressed') {
    return { scope: 'task', reason: 'execute-regressed', fromBaseline, fromExecute };
  }

  return { scope: 'none', reason: 'clean', fromBaseline, fromExecute };
}

// 退步的關卡寫成一句話。關卡種類要分開講:「驗證指令 npm test 本來會過」和
// 「反例『負數會溢位』本來已經修好」對使用者是兩件不同的事。
export function describeChanges(changes: GateChange[], locale: TextLocale = 'zh-Hant'): string {
  return changes.map((change) => tx(locale, ({
    syntax: 'ratchet.itemSyntax',
    gate: 'ratchet.itemGate',
    counterexample: 'ratchet.itemCounterexample',
  } as const)[change.kind], { label: change.label })).join('\n');
}
