// 評測用的統計:次數少的時候,「12/15 比 11/14」這種差距幾乎一定是運氣。
// 把不確定性一起報出來,才不會把雜訊讀成結論。

// Wilson 分數區間:比例的 95% 信賴區間。次數少、比例接近 0 或 1 時比常態近似可靠
export function wilson(k: number, n: number, z = 1.96): [number, number] {
  if (n <= 0) return [0, 1];
  const p = k / n;
  const denom = 1 + (z * z) / n;
  const center = (p + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return [Math.max(0, center - half), Math.min(1, center + half)];
}

// Fisher 精確檢定(雙尾):兩組的成功比例一樣時,看到至少這麼極端的結果的機率。
//   a/b:第一組成功/失敗,c/d:第二組成功/失敗
// p 值大(例如 > 0.05)代表「這個差距用運氣就解釋得了」,不代表兩組一樣好。
export function fisherExact(a: number, b: number, c: number, d: number): number {
  const n = a + b + c + d;
  const row1 = a + b;
  const col1 = a + c;
  const logFact = (x: number) => { let s = 0; for (let i = 2; i <= x; i++) s += Math.log(i); return s; };
  const logP = (x: number) => logFact(row1) + logFact(n - row1) + logFact(col1) + logFact(n - col1)
    - logFact(n) - logFact(x) - logFact(row1 - x) - logFact(col1 - x) - logFact(n - row1 - col1 + x);
  const observed = logP(a);
  let p = 0;
  for (let x = Math.max(0, row1 + col1 - n); x <= Math.min(row1, col1); x++) {
    const lp = logP(x);
    // 容許一點浮點誤差:和觀察值一樣極端的也要算進去
    if (lp <= observed + 1e-9) p += Math.exp(lp);
  }
  return Math.min(1, p);
}

// 要偵測出「成功率從 p1 變成 p2」這麼大的差距,每組大約要幾次(雙尾 α=0.05、檢定力 80%,常態近似)
export function runsNeeded(p1: number, p2: number): number {
  const za = 1.96, zb = 0.8416;
  const pbar = (p1 + p2) / 2;
  const num = za * Math.sqrt(2 * pbar * (1 - pbar)) + zb * Math.sqrt(p1 * (1 - p1) + p2 * (1 - p2));
  const diff = Math.abs(p1 - p2);
  return diff === 0 ? Infinity : Math.ceil((num * num) / (diff * diff));
}

// 分層置換檢定(雙尾):主要指標用每次的「測試通過比例」,比「全對與否」多很多資訊。
// 每一題是一層:只在同一題裡交換兩組的標籤,題目難度不同不會混進差距。
// 統計量是各題「b 組平均 − a 組平均」的平均;回傳觀察到的差距與 p 值。
export function stratifiedPermutation(strata: Array<{ a: number[]; b: number[] }>, iterations = 20000, seed = 1): { diff: number; p: number } {
  const used = strata.filter((s) => s.a.length && s.b.length);
  if (!used.length) return { diff: 0, p: 1 };
  const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
  const stat = (groups: Array<{ a: number[]; b: number[] }>) => groups.reduce((s, g) => s + mean(g.b) - mean(g.a), 0) / groups.length;
  const observed = stat(used);
  // 固定種子的亂數:同樣的資料每次算出同樣的 p 值,結果可以重現
  let x = seed >>> 0;
  const rand = () => { x = (x + 0x6d2b79f5) >>> 0; let t = x; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  let extreme = 0;
  for (let i = 0; i < iterations; i++) {
    const shuffled = used.map((g) => {
      const all = [...g.a, ...g.b];
      for (let j = all.length - 1; j > 0; j--) { const k = Math.floor(rand() * (j + 1)); [all[j], all[k]] = [all[k], all[j]]; }
      return { a: all.slice(0, g.a.length), b: all.slice(g.a.length) };
    });
    if (Math.abs(stat(shuffled)) >= Math.abs(observed) - 1e-12) extreme++;
  }
  // 加一:把觀察到的那一組也算進去,p 值不會是 0
  return { diff: observed, p: (extreme + 1) / (iterations + 1) };
}
