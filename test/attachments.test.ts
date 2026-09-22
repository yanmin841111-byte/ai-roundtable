'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const A = require('../src/attachments');
const { buildUserContent } = require('../src/adapters/openai-adapter');
const { writeSession, deleteSession, listConversationIds, messagesToMarkdown } = require('../src/session-log');
const { Orchestrator, describeGitChanges, parsePorcelain } = require('../src/orchestrator');

let n = 0;
const t = (name: any, fn: any) => { fn(); n++; console.log('ok -', name); };
const tmp = (tag: any) => fs.mkdtempSync(path.join(os.tmpdir(), `ai-roundtable-${tag}-`));

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02]);
const CONV = 'conv-0001';
const item = (name: any, data: any) => ({ name, data: Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8') });
const addOne = (dir: any, name: any, data: any, conv: any = CONV) => A.addAttachments(dir, conv, [item(name, data)]);

// ---------- 落地與 metadata ----------
t('附件寫進 userData/attachments/<conversationId>/,metadata 不含檔案內容', () => {
  const dir = tmp('att');
  const { added, errors } = addOne(dir, '報告.md', '# hello');
  assert.deepStrictEqual(errors, []);
  assert.strictEqual(added.length, 1);
  const meta = added[0];
  assert.strictEqual(meta.kind, 'text');
  assert.strictEqual(meta.mime, 'text/markdown');
  assert.strictEqual(meta.name, '報告.md');
  assert.strictEqual(meta.size, Buffer.byteLength('# hello'));
  assert.strictEqual(meta.relPath.split('/')[0], CONV);
  assert.ok(!('data' in meta) && !('base64' in meta), 'metadata 不可挾帶內容');
  const abs = A.absolutePath(dir, meta);
  assert.strictEqual(fs.readFileSync(abs, 'utf8'), '# hello');
  assert.ok(abs.startsWith(path.join(dir, 'attachments', CONV) + path.sep));
});

t('儲存檔名保留可讀的原檔名,但只留安全字元', () => {
  const dir = tmp('att');
  const { added } = addOne(dir, '../../evil name;rm -rf.txt', 'x');
  const stored = path.basename(added[0].relPath);
  assert.ok(stored.startsWith(`${added[0].id}__`), '前綴是 uuid');
  assert.ok(/^[\w.-]+$/.test(stored), `檔名只含安全字元,實際:${stored}`);
  assert.ok(!stored.includes('..') && !stored.includes('/'));
});

t('長檔名與控制字元會安全縮短,不會撞上 conversationId 的 64 字元限制', () => {
  const dir = tmp('att');
  const name = `${'a'.repeat(120)}\n偽指令.txt`;
  const { added, errors } = addOne(dir, name, 'x');
  assert.deepStrictEqual(errors, []);
  assert.strictEqual(added.length, 1);
  assert.ok(!/[\r\n]/.test(added[0].name));
  assert.ok(path.basename(added[0].relPath).length > 64, '儲存檔名可以比 conversationId 長');
  assert.ok(A.absolutePath(dir, added[0]));
});

t('attachments 或 conversation 目錄是符號連結時拒絕寫入', () => {
  const dir = tmp('att');
  const outside = tmp('outside');
  fs.symlinkSync(outside, path.join(dir, 'attachments'));
  const first = addOne(dir, 'a.txt', 'secret');
  assert.strictEqual(first.added.length, 0);
  assert.match(first.errors[0].error, /符號連結/);
  assert.deepStrictEqual(fs.readdirSync(outside), []);

  const dir2 = tmp('att');
  fs.mkdirSync(path.join(dir2, 'attachments'));
  fs.symlinkSync(outside, path.join(dir2, 'attachments', CONV));
  const second = addOne(dir2, 'b.txt', 'secret');
  assert.strictEqual(second.added.length, 0);
  assert.match(second.errors[0].error, /符號連結/);
  assert.deepStrictEqual(fs.readdirSync(outside), []);
});

// ---------- 白名單與內容檢查 ----------
t('不在白名單的副檔名被擋下並說明原因', () => {
  const dir = tmp('att');
  const { added, errors } = addOne(dir, 'a.exe', 'x');
  assert.strictEqual(added.length, 0);
  assert.match(errors[0].error, /不支援的檔案類型/);
});

t('副檔名與 magic bytes 不符時拒收', () => {
  const dir = tmp('att');
  const { added, errors } = addOne(dir, 'fake.png', 'this is plain text, not a png');
  assert.strictEqual(added.length, 0);
  assert.match(errors[0].error, /副檔名與實際內容不符/);
});

t('正確的 magic bytes 才通過', () => {
  const dir = tmp('att');
  for (const [name, data] of [
    ['a.png', PNG],
    ['a.gif', Buffer.from('GIF89a\x00\x00')],
    ['a.pdf', Buffer.from('%PDF-1.7\n%…')],
    ['a.webp', Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')])],
    ['a.jpg', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00])],
  ]) {
    const { added, errors } = addOne(dir, name, data);
    assert.strictEqual(added.length, 1, `${name} 應通過,錯誤:${JSON.stringify(errors)}`);
    assert.strictEqual(added[0].kind, String(name).endsWith('.pdf') ? 'pdf' : 'image');
  }
});

t('偽裝成文字檔的二進位檔被擋下', () => {
  const dir = tmp('att');
  const macho = Buffer.concat([Buffer.from([0xcf, 0xfa, 0xed, 0xfe]), Buffer.alloc(16)]);
  assert.match(addOne(dir, 'payload.txt', macho).errors[0].error, /執行檔/);
  const zip = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(16)]);
  assert.match(addOne(dir, 'payload.md', zip).errors[0].error, /ZIP/);
});

t('文字檔含 NUL 或非 UTF-8 時拒收', () => {
  const dir = tmp('att');
  assert.match(addOne(dir, 'a.log', Buffer.from('ok\x00bad')).errors[0].error, /NUL/);
  // 0xC3 0x28 是無效的 UTF-8 續接位元組組合
  assert.match(addOne(dir, 'b.csv', Buffer.from([0x61, 0xc3, 0x28, 0x62])).errors[0].error, /UTF-8/);
  assert.strictEqual(addOne(dir, 'c.txt', '中文與 emoji 🎉 都要能通過').added.length, 1);
});

t('json 附件必須真的是 JSON,並接受 UTF-8 BOM', () => {
  const dir = tmp('att');
  assert.match(addOne(dir, 'bad.json', 'plain text').errors[0].error, /有效的 JSON/);
  assert.strictEqual(addOne(dir, 'good.json', '\uFEFF{"ok":true}').added.length, 1);
});

t('空檔案被擋下', () => {
  assert.match(addOne(tmp('att'), 'a.txt', Buffer.alloc(0)).errors[0].error, /空的/);
});

// ---------- 上限 ----------
t('超過單次 10 個檔的部分被擋下,前 10 個照常收下', () => {
  const dir = tmp('att');
  const items = Array.from({ length: 12 }, (_: any, i: any) => item(`f${i}.txt`, `x${i}`));
  const { added, errors } = A.addAttachments(dir, CONV, items);
  assert.strictEqual(added.length, 10);
  assert.strictEqual(errors.length, 2);
  assert.match(errors[0].error, /最多 10 個檔案/);
});

t('existingCount 讓已在清單上的 chip 也算進 10 個上限', () => {
  const dir = tmp('att');
  const r = A.addAttachments(dir, CONV, [item('a.txt', 'x'), item('b.txt', 'y')], { existingCount: 9 });
  assert.strictEqual(r.added.length, 1);
  assert.strictEqual(r.errors.length, 1);
});

t('單檔超過 20 MB 被擋下,並說出實際大小', () => {
  const dir = tmp('att');
  const big = Buffer.alloc(A.LIMITS.maxFileBytes + 1, 0x61);
  const { added, errors } = addOne(dir, 'big.txt', big);
  assert.strictEqual(added.length, 0);
  assert.match(errors[0].error, /超過單檔上限 20\.0 MB/);
  assert.match(errors[0].error, /20\.0 MB\)$/);
});

t('單次合計超過 50 MB 被擋下', () => {
  const dir = tmp('att');
  const chunk = () => Buffer.alloc(20 * 1024 * 1024, 0x61);
  const { added, errors } = A.addAttachments(dir, CONV, [
    item('a.txt', chunk()), item('b.txt', chunk()), item('c.txt', chunk()),
  ]);
  assert.strictEqual(added.length, 2, '前兩個 20 MB 收下,第三個會撞到 50 MB 上限');
  assert.match(errors[0].error, /超過單次合計上限 50\.0 MB/);
});

t('檔案路徑來源在讀檔前就先用 stat 擋掉超大檔', () => {
  const dir = tmp('att');
  const src = path.join(tmp('src'), 'huge.txt');
  fs.writeFileSync(src, Buffer.alloc(A.LIMITS.maxFileBytes + 1024, 0x61));
  const { added, errors } = A.addAttachments(dir, CONV, [{ name: 'huge.txt', path: src }]);
  assert.strictEqual(added.length, 0);
  assert.match(errors[0].error, /超過單檔上限/);
});

// ---------- 路徑安全 ----------
t('帶目錄成分的 conversationId 一律拒絕,不默默修正', () => {
  const dir = tmp('att');
  for (const bad of ['../escape', 'a/b', '..', '.', '', 'x'.repeat(65), '/abs']) {
    assert.strictEqual(A.conversationDir(dir, bad), null, `應拒絕:${JSON.stringify(bad)}`);
    assert.strictEqual(A.addAttachments(dir, bad, [item('a.txt', 'x')]).added.length, 0);
  }
  assert.ok(A.conversationDir(dir, 'ok-1_2.3'));
});

t('relPath 被竄改時 absolutePath 回 null,不會讀到目錄外的檔', () => {
  const dir = tmp('att');
  for (const relPath of ['../../etc/passwd', 'conv/../../x', 'onlyonepart', 'a/b/c']) {
    assert.strictEqual(A.absolutePath(dir, { relPath }), null, relPath);
  }
});

// ---------- 刪除與清理 ----------
t('removeAttachment 刪掉檔案', () => {
  const dir = tmp('att');
  const meta = addOne(dir, 'a.txt', 'x').added[0];
  const abs = A.absolutePath(dir, meta);
  assert.ok(fs.existsSync(abs));
  assert.strictEqual(A.removeAttachment(dir, meta).ok, true);
  assert.strictEqual(fs.existsSync(abs), false);
});

t('cleanupOrphans 只清從未寫進 session 且過了寬限期的目錄', () => {
  const dir = tmp('att');
  addOne(dir, 'a.txt', 'x', 'saved-conv');
  addOne(dir, 'b.txt', 'y', 'orphan-conv');
  addOne(dir, 'c.txt', 'z', 'active-conv');
  addOne(dir, 'd.txt', 'w', 'fresh-conv');
  const day = 24 * 60 * 60 * 1000;
  const old = Date.now() - 3 * day;
  for (const id of ['saved-conv', 'orphan-conv', 'active-conv']) {
    fs.utimesSync(path.join(dir, 'attachments', id), new Date(old), new Date(old));
  }
  const { removed } = A.cleanupOrphans(dir, { keepIds: ['saved-conv'], activeId: 'active-conv' });
  assert.deepStrictEqual(removed, ['orphan-conv']);
  for (const id of ['saved-conv', 'active-conv', 'fresh-conv']) {
    assert.ok(fs.existsSync(path.join(dir, 'attachments', id)), `${id} 不該被清掉`);
  }
});

t('attachments 根目錄還不存在時 cleanupOrphans 不算錯誤', () => {
  const r = A.cleanupOrphans(tmp('empty'), {});
  assert.deepStrictEqual(r, { removed: [] });
});

// ---------- 沙箱 CLI 的工作目錄暫存 ----------
t('stageToCwd 複製到 .roundtable-runtime,clearRuntime 完全清乾淨', () => {
  const dir = tmp('att');
  const work = tmp('work');
  const meta = addOne(dir, 'spec.md', '# spec').added[0];
  const { staged, error } = A.stageToCwd(dir, CONV, work, [meta]);
  assert.strictEqual(error, undefined);
  assert.strictEqual(staged.length, 1);
  assert.ok(staged[0].cwdPath.startsWith(path.join(work, A.RUNTIME_DIR, CONV) + path.sep));
  assert.strictEqual(fs.readFileSync(staged[0].cwdPath, 'utf8'), '# spec');
  assert.strictEqual(A.clearRuntime(work, CONV).ok, true);
  assert.strictEqual(fs.existsSync(path.join(work, A.RUNTIME_DIR)), false, '空的 runtime 目錄也要一併移除');
  // 權威副本還在
  assert.ok(fs.existsSync(A.absolutePath(dir, meta)));
});

t('clearRuntime 對不存在的目錄回成功', () => {
  assert.strictEqual(A.clearRuntime(tmp('work')).ok, true);
  assert.strictEqual(A.clearRuntime(null).ok, true);
});

t('runtime 目錄是符號連結時不沿連結寫入或遞迴刪除', () => {
  const dir = tmp('att');
  const work = tmp('work');
  const outside = tmp('outside');
  const meta = addOne(dir, 'a.txt', 'x').added[0];
  fs.symlinkSync(outside, path.join(work, A.RUNTIME_DIR));
  const result = A.stageToCwd(dir, CONV, work, [meta]);
  assert.match(result.error, /符號連結/);
  assert.deepStrictEqual(fs.readdirSync(outside), []);
  assert.strictEqual(A.clearRuntime(work, CONV).ok, true);
  assert.ok(fs.existsSync(outside), '只能移除連結,不可刪掉外部目錄');
  assert.ok(!fs.existsSync(path.join(work, A.RUNTIME_DIR)));
});

t('Orchestrator.stop 立即清除 runtime,不等待外部 CLI close', () => {
  const work = tmp('work');
  const store = {
    userDataDir: tmp('user-data'),
    get: () => ({ agents: [], settings: { workDir: work } }),
  };
  const orchestrator = new Orchestrator(store);
  const runtime = path.join(work, A.RUNTIME_DIR, orchestrator.conversationId);
  fs.mkdirSync(runtime, { recursive: true });
  fs.writeFileSync(path.join(runtime, 'pending.txt'), 'x');
  orchestrator.staged = [{ id: 'x' }];
  orchestrator.stop();
  assert.ok(!fs.existsSync(path.join(work, A.RUNTIME_DIR)));
  assert.deepStrictEqual(orchestrator.staged, []);
});

t('describeGitChanges 排除 .roundtable-runtime,附件不會被誤報成成員的變更', () => {
  const after = parsePorcelain([
    '?? .roundtable-runtime/conv/pic.png',
    '?? .roundtable-runtime/',
    ' M src/app.js',
  ].join('\n'));
  const out = describeGitChanges(null, after);
  assert.ok(!out.includes('roundtable-runtime'), `不該出現暫存目錄:\n${out}`);
  assert.ok(out.includes('src/app.js'));
  // 只有暫存目錄有變更時,等同「沒有變更」
  assert.strictEqual(describeGitChanges(null, parsePorcelain('?? .roundtable-runtime/conv/pic.png')), null);
});

t('隔離回合的附件放在自己的目錄,回合結束清除副本', async () => {
  const userDataDir = tmp('att');
  const work = tmp('work');
  const lane = tmp('lane');
  const meta = addOne(userDataDir, 'spec.md', '# spec').added[0];
  const agent = { id: 'writer', name: 'Writer', cli: 'writer', canEdit: true, enabled: true };
  let seen = false;
  require('../src/adapters').setRegistry({ get: () => ({
    id: 'writer', supportsEdit: true, capabilities: { attachments: ['filePath'], attachmentsNeedCwd: true },
    run: async (_agent: any, ctx: any) => {
      const attachment = ctx.attachments[0];
      assert.ok(attachment.path.startsWith(lane + path.sep));
      assert.strictEqual(fs.readFileSync(attachment.path, 'utf8'), '# spec');
      assert.ok(ctx.prompt.includes(attachment.path));
      seen = true;
      return { text: 'done' };
    },
  }) });
  const orchestrator = new Orchestrator({ userDataDir, get: () => ({ agents: [agent], settings: { workDir: work } }) });
  orchestrator.attachments = [meta];
  await orchestrator.turn(agent, 'write', { cwd: lane, freshContext: true });
  assert.ok(seen);
  assert.strictEqual(fs.existsSync(path.join(lane, A.RUNTIME_DIR)), false);
  assert.ok(fs.existsSync(A.absolutePath(userDataDir, meta)));
});

// ---------- 能力宣告與提示詞 ----------
t('adapter 沒宣告 capabilities 時依 supportsEdit 推斷', () => {
  assert.deepStrictEqual([...A.attachmentCapabilities({ supportsEdit: true }).modes], ['filePath', 'textInline']);
  assert.deepStrictEqual([...A.attachmentCapabilities({ supportsEdit: false }).modes], ['textInline']);
  assert.strictEqual(A.attachmentCapabilities(null).needCwd, false);
  const declared = A.attachmentCapabilities({ capabilities: { attachments: ['imageInline'], attachmentsNeedCwd: true } });
  assert.deepStrictEqual([...declared.modes], ['imageInline']);
  assert.strictEqual(declared.needCwd, true);
});

t('filePath 型 adapter 拿到絕對路徑,不內嵌內容', () => {
  const dir = tmp('att');
  const meta = addOne(dir, 'notes.md', '機密內容').added[0];
  const out = A.buildAttachmentPrompt(dir, [meta], { capabilities: { attachments: ['filePath'] } });
  assert.ok(out.includes(A.absolutePath(dir, meta)));
  assert.ok(!out.includes('機密內容'), 'filePath 模式不該把內容塞進提示詞');
});

t('沙箱 adapter 拿到的是工作目錄副本的路徑', () => {
  const dir = tmp('att');
  const work = tmp('work');
  const meta = addOne(dir, 'notes.md', 'hi').added[0];
  const { staged } = A.stageToCwd(dir, CONV, work, [meta]);
  const adapter = { capabilities: { attachments: ['filePath'], attachmentsNeedCwd: true } };
  const out = A.buildAttachmentPrompt(dir, [meta], adapter, { staged });
  assert.ok(out.includes(staged[0].cwdPath));
  assert.ok(!out.includes(path.join(dir, 'attachments')));
  A.clearRuntime(work, CONV);
});

t('沙箱附件暫存失敗時不回退到讀不到的 userData 路徑', () => {
  const dir = tmp('att');
  const meta = addOne(dir, 'notes.md', 'hi').added[0];
  const adapter = { capabilities: { attachments: ['filePath'], attachmentsNeedCwd: true } };
  const out = A.buildAttachmentPrompt(dir, [meta], adapter, { staged: [] });
  assert.ok(!out.includes(A.absolutePath(dir, meta)));
  assert.match(out, /無法讀取/);
});

t('textInline 型 adapter 內嵌文字內容,並在過長時截斷', () => {
  const dir = tmp('att');
  const meta = addOne(dir, 'notes.txt', 'abc123').added[0];
  const adapter = { capabilities: { attachments: ['textInline'] } };
  assert.ok(A.buildAttachmentPrompt(dir, [meta], adapter).includes('abc123'));

  const long = addOne(dir, 'long.txt', 'x'.repeat(30000)).added[0];
  const out = A.buildAttachmentPrompt(dir, [long], adapter);
  assert.ok(out.includes('已截斷'));
  assert.ok(out.length < 25000, '截斷後不該還帶著整份 30000 字');
});

t('多個 textInline 附件共用總預算,不會把 20 萬字灌進單次提示詞', () => {
  const dir = tmp('att');
  const metas: any[] = [];
  for (let i = 0; i < 4; i++) metas.push(addOne(dir, `long-${i}.txt`, String(i).repeat(20000)).added[0]);
  const out = A.buildAttachmentPrompt(dir, metas, { capabilities: { attachments: ['textInline'] } });
  assert.ok(out.length < 45000, `提示詞過長:${out.length}`);
  assert.match(out, /總內嵌上限/);
});

t('讀不到內容的附件會明講,避免模型憑檔名臆測', () => {
  const dir = tmp('att');
  const meta = addOne(dir, 'chart.png', PNG).added[0];
  const out = A.buildAttachmentPrompt(dir, [meta], { capabilities: { attachments: ['textInline'] } });
  assert.ok(out.includes('chart.png'));
  assert.ok(out.includes('無法讀取') && out.includes('不要憑檔名臆測'));
});

t('imageInline 型 adapter 只拿到清單,影像由 adapter 自己從 ctx.attachments 取', () => {
  const dir = tmp('att');
  const meta = addOne(dir, 'chart.png', PNG).added[0];
  const out = A.buildAttachmentPrompt(dir, [meta], { capabilities: { attachments: ['imageInline'] } });
  assert.ok(out.includes('影像已隨訊息附上'));
  assert.ok(!out.includes('無法讀取'));
});

t('OpenAI imageInline 會產生真正的 data URL content part', () => {
  const dir = tmp('image-inline');
  const file = path.join(dir, 'a.png');
  fs.writeFileSync(file, PNG);
  const content = buildUserContent('請看圖', [{ kind: 'image', mime: 'image/png', path: file }], { attachments: ['imageInline'] });
  assert.strictEqual(content[0].text, '請看圖');
  assert.match(content[1].image_url.url, /^data:image\/png;base64,/);
});

t('沒有附件時不產生任何提示詞片段', () => {
  assert.strictEqual(A.buildAttachmentPrompt(tmp('att'), [], { supportsEdit: true }), '');
});

// ---------- 與對話紀錄的連動 ----------
t('session 寫入 conversationId,刪除對話時連動清掉附件目錄', () => {
  const dir = tmp('att');
  const meta = addOne(dir, 'a.txt', 'x').added[0];
  const attDir = path.join(dir, 'attachments', CONV);
  assert.ok(fs.existsSync(attDir));

  const r = writeSession(dir, [{ kind: 'user', ts: 1, text: '看這張圖', attachments: [meta] }], { conversationId: CONV });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(JSON.parse(fs.readFileSync(r.file, 'utf8')).conversationId, CONV);
  assert.deepStrictEqual(listConversationIds(dir), [CONV]);

  assert.strictEqual(deleteSession(dir, path.basename(r.file)).ok, true);
  assert.strictEqual(fs.existsSync(attDir), false, '刪對話要連動刪附件');
});

t('同一 conversation 分成多份 session 時,刪到最後一份才清附件', () => {
  const dir = tmp('att');
  addOne(dir, 'a.txt', 'x');
  const first = writeSession(dir, [{ kind: 'user', ts: 1, text: '一' }], { conversationId: CONV });
  const second = writeSession(dir, [{ kind: 'user', ts: 2, text: '二' }], { conversationId: CONV });
  const attDir = path.join(dir, 'attachments', CONV);
  deleteSession(dir, path.basename(first.file));
  assert.ok(fs.existsSync(attDir), '仍有另一份 session 引用時不可清附件');
  deleteSession(dir, path.basename(second.file));
  assert.ok(!fs.existsSync(attDir), '最後一份 session 刪除後才清附件');
});

t('沒帶 conversationId 時從訊息的 relPath 還原,舊紀錄一樣清得掉', () => {
  const dir = tmp('att');
  const meta = addOne(dir, 'a.txt', 'x').added[0];
  const r = writeSession(dir, [{ kind: 'user', ts: 1, text: 'hi', attachments: [meta] }]);
  assert.strictEqual(JSON.parse(fs.readFileSync(r.file, 'utf8')).conversationId, CONV);
  deleteSession(dir, path.basename(r.file));
  assert.strictEqual(fs.existsSync(path.join(dir, 'attachments', CONV)), false);
});

t('沒有附件的對話不受影響', () => {
  const dir = tmp('att');
  const r = writeSession(dir, [{ kind: 'user', ts: 1, text: '純文字' }]);
  assert.strictEqual(JSON.parse(fs.readFileSync(r.file, 'utf8')).conversationId, null);
  assert.deepStrictEqual(listConversationIds(dir), []);
  assert.strictEqual(deleteSession(dir, path.basename(r.file)).ok, true);
});

t('匯出的 Markdown 會列出附件', () => {
  const md = messagesToMarkdown([
    { kind: 'user', ts: 1, text: '看這個', attachments: [{ name: 'a.png', mime: 'image/png' }] },
    { kind: 'user', ts: 2, attachments: [{ name: 'b.txt', mime: 'text/plain' }] },
  ]);
  assert.ok(md.includes('> 附件：a.png（image/png）'));
  assert.ok(!md.includes('_(無文字內容)_'), '只有附件時不該說「無文字內容」');
});

console.log(`\n${n} 項 attachments 測試全部通過`);
