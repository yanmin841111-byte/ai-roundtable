// 端對端劇本:由 test/e2e/run.ts 注入 E2E 常數後,在 renderer 裡執行。
// 成員是兩個假的「自訂指令」(fake-agent.js),不會用到任何真正的 CLI 或 API 額度。
// 每個 check 通過就記一筆;失敗時回傳 ok: false 與已通過的步驟,方便看出卡在哪。
(async () => {
  const steps = [];
  const check = (cond, msg) => { if (!cond) throw new Error(`失敗:${msg}`); steps.push(msg); };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const api = window.api;
  const snapshot = () => api.snapshot();
  const waitIdle = async () => {
    for (let i = 0; i < 600; i++) { if (!(await snapshot()).running) return; await sleep(100); }
    throw new Error('任務 60 秒內沒有結束');
  };
  const runTask = async (text, mode, attachments) => {
    const before = (await snapshot()).messages.length;
    await api.send(text, mode, attachments);
    await sleep(200);
    await waitIdle();
    await sleep(500); // 紀錄檔在 idle 事件後才寫入
    return (await snapshot()).messages.slice(before);
  };

  try {
    // 介面初始化要等 IPC 回來才會綁事件;先等它完成再操作
    for (let i = 0; i < 300 && !document.querySelector('#settings-btn').onclick; i++) await sleep(100);
    check(!!document.querySelector('#settings-btn').onclick, '介面初始化完成');
    check(document.documentElement.lang === 'zh-Hant', '介面語言為繁體中文');

    const cfg = await api.getConfig();
    check(cfg.agents.length === 2 && cfg.settings.workDir === E2E.workDir, '設定檔載入:兩位成員與工作目錄');
    const types = await api.cliTypes();
    check(!!types.custom && Object.keys(types).length >= 4, '轉接器目錄含內建的四個');

    // ---------- 附件 ----------
    const add = await api.attachments.add([
      { name: 'note.txt', path: E2E.noteFile },
      { name: 'dot.png', path: E2E.pngFile },
      { name: 'evil.txt', path: E2E.pngFile },
    ]);
    check(add.added.length === 2 && add.errors.length === 1 && add.errors[0].name === 'evil.txt', '附件:文字檔與圖片加入,偽裝成 .txt 的 PNG 被拒');
    check(add.added[1].kind === 'image' && !!add.added[1].thumb, '圖片附件有縮圖');
    const thumb = await api.attachments.thumb(add.added[1]);
    check(typeof thumb === 'string' && thumb.startsWith('data:image/png;base64,'), '縮圖以 data URL 回傳');
    check((await api.attachments.thumb({ id: '../x', thumb: 'thumbs/../../x.png', relPath: '../../etc/passwd' })) === null, '縮圖的路徑穿越被擋下');
    check((await api.attachments.list()).attachments.length === 2, '待送附件清單有兩筆');

    // ---------- 完整圓桌 ----------
    const round = await runTask('請兩位分工建立檔案', 'divide', add.added);
    check(round[0].kind === 'user' && round[0].attachments.length === 2, '使用者訊息帶著兩個附件');
    const agents = round.filter((m) => m.kind === 'agent');
    const phases = agents.map((m) => m.phase && m.phase.code).join(',');
    // 修復之後,原本的審查者再複查一次(review 出現在 repair 之後)
    check(phases === 'discuss,discuss,divide,execute,execute,review,review,repair,review,summary', `階段順序正確(${phases})`);
    check(agents.every((m) => m.status === 'done' && !m.error), '所有成員回合都完成、沒有錯誤');
    // 自訂指令成員的能力是「給檔案路徑」(可改檔案的本機 CLI),不內嵌文字
    check(agents[0].text.includes('附件=true') && agents[0].text.includes('路徑=true') && agents[0].text.includes('文字=false'), '成員的提示詞含附件區塊與檔案路徑,不內嵌文字');
    check(round.some((m) => m.kind === 'system' && m.tag === 'plan'), '有分工結果的系統訊息');
    check(round.some((m) => m.kind === 'system' && m.text.includes('全員達成共識')), '討論達成共識的系統訊息');
    const groups = new Set(agents.filter((m) => m.group).map((m) => m.group));
    check(groups.size === 3 && agents[3].group === agents[4].group && agents[5].group === agents[6].group && !agents[7].group, '執行與審查各自並排,修復依序呈現');
    check(agents[7].agentName === '乙' && agents[7].phase.code === 'repair', '只有被審查出問題的乙進入修復回合');
    check(agents[8].agentName === '甲' && agents[8].phase.code === 'review' && agents[8].review && agents[8].review.recheck && agents[8].review.target === '乙', '修復後由原本的審查者甲複查乙');
    check(agents[9].agentName === '甲' && agents[9].phase.code === 'summary', '主持人甲做總結');
    check((await api.attachments.list()).attachments.length === 0, '送出後待送附件清空');
    check(document.querySelectorAll('#timeline .msg').length === round.length, '時間軸畫出每一則訊息');
    check(document.querySelectorAll('#timeline .msg-group').length === 3, '時間軸有三組並排(執行、審查、複查),修復不並排');

    // ---------- 歷史紀錄 ----------
    const list = await api.sessions.list();
    check(list.sessions.length === 1 && list.sessions[0].attachmentCount === 2, '任務結束自動存成一筆紀錄,附件數正確');
    const sessionId = list.sessions[0].id;
    const read = await api.sessions.read(sessionId);
    check(read.ok && read.session.messages.length === round.length, '紀錄可讀取且訊息數一致');
    check((await api.sessions.read('../config.json')).ok === false, '歷史紀錄的路徑穿越被擋下');

    // ---------- @ 指定 ----------
    const directed = await runTask('@甲 你好', 'divide', []);
    check(directed[0].kind === 'user' && directed[0].directed === true, '閒置時 @ 指定的訊息標為 directed');
    const replies = directed.filter((m) => m.kind === 'agent');
    check(replies.length === 1 && replies[0].agentName === '甲' && replies[0].phase.code === 'direct', '只有被指定的甲回覆,不跑討論流程');
    check((await api.sessions.list()).sessions.length === 1, '同一段對話寫回同一筆紀錄');

    // ---------- 選項式提問 ----------
    // 讓甲在討論第 1 回合用 [ASK] 反問,驗證卡片、點選項、回答回灌與停止解鎖
    const askCfg = await api.getConfig();
    askCfg.agents = askCfg.agents.map((a) => (a.name === '甲' ? { ...a, customCommand: `${a.customCommand} --ask` } : a));
    await api.saveConfig(askCfg);
    const waitCard = async () => {
      for (let i = 0; i < 300; i++) { if (document.querySelector('#pending-question')) return true; await sleep(100); }
      return false;
    };

    await api.reset();
    await api.send('接本地模型', 'discuss', []);
    check(await waitCard(), '成員提問時介面出現選項卡片');
    const card = document.querySelector('#pending-question');
    check(card.querySelector('.question-text').textContent === '要先接哪一種本地端點?', '卡片顯示問題內容');
    const opts = card.querySelectorAll('.question-option');
    check(opts.length === 2 && opts[1].textContent.includes('LM Studio'), '兩個選項都畫出來了');
    check(!!card.querySelector('.question-free input'), '選項之外仍可自由輸入');
    check((await snapshot()).running === true, '等待回答期間流程仍在進行中');
    const waitingMsgs = (await snapshot()).messages.filter((m) => m.kind === 'agent');
    check(!waitingMsgs.some((m) => m.text.includes('[ASK]')), '訊息本體不留 [ASK] 標記');
    check(!waitingMsgs.some((m) => m.text.includes('要先接哪一種本地端點?')), '問題只出現在卡片,不在氣泡裡重複');

    opts[1].click(); // 使用者點下第二個選項
    await waitIdle();
    await sleep(500);
    const asked = (await snapshot()).messages;
    const reply = asked.find((m) => m.kind === 'user' && m.text.includes('LM Studio'));
    check(!!reply, '回答寫進對話紀錄');
    check(reply.text.includes('甲'), '回答標明是回覆哪位成員的提問');
    check(!document.querySelector('#pending-question'), '結算後卡片收起來');
    check(asked.some((m) => m.kind === 'agent' && m.agentName === '乙'), '回答後流程繼續,乙接著發言');

    // 等待中按停止:不能卡在 await,而且不該補一則回答
    await api.reset();
    await api.send('再問一次', 'discuss', []);
    check(await waitCard(), '第二次提問的卡片出現');
    await api.stop();
    await waitIdle();
    check(!document.querySelector('#pending-question'), '停止後卡片收起來');
    const stopped = (await snapshot()).messages;
    check(stopped.some((m) => m.kind === 'system' && m.text.includes('已停止')), '停止時流程確實結束,沒有卡在等待');
    check(!stopped.some((m) => m.kind === 'user' && m.text.includes('自行決定')), '停止時不補寫回答訊息');

    // 還原設定,後面的檢查沿用原本的假成員
    await api.saveConfig(cfg);
    await api.reset();
    for (const s of (await api.sessions.list()).sessions) if (s.id !== sessionId) await api.sessions.remove(s.id);

    // ---------- 載入與刪除 ----------
    await api.reset();
    check((await snapshot()).messages.length === 0, '新對話後訊息清空');
    const resumed = await api.resume(sessionId);
    check(resumed.ok && resumed.snapshot.messages.length === round.length + directed.length, '載入歷史紀錄後訊息完整');
    await api.reset();
    const removed = await api.sessions.remove(sessionId);
    check(removed.ok && (await api.sessions.list()).sessions.length === 0, '刪除紀錄後清單為空');

    return { ok: true, steps };
  } catch (error) {
    return { ok: false, error: String((error && error.stack) || error), steps };
  }
})();
