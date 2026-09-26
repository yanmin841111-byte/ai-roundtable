import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import type { AppConfig } from './ipc-types';
import { sanitizeLineups } from './lineups';

function defaultConfig(): AppConfig {
  return {
    agents: [
      {
        id: crypto.randomUUID(),
        name: 'Claude',
        cli: 'claude',
        model: 'claude-opus-5',
        effort: 'high',
        persona: '嚴謹的資深架構師。重視正確性與可維護性,喜歡先釐清需求與邊界條件再動手,會主動指出風險與遺漏。',
        color: '#d97757',
        canEdit: true,
        enabled: true,
        customCommand: '',
      },
      {
        id: crypto.randomUUID(),
        name: 'Codex',
        cli: 'codex',
        model: 'gpt-5.6-sol',
        effort: 'high',
        persona: '務實的實作工程師。動作快、重視可運行的結果,喜歡用具體程式碼與範例說話,對過度設計會直接提出質疑。',
        color: '#10a37f',
        canEdit: true,
        enabled: true,
        customCommand: '',
      },
    ],
    settings: {
      workDir: path.join(os.homedir(), 'AI_Roundtable_Workspace'),
      maxRounds: 3,
      discussionMode: 'sequential',
      mode: 'divide',
      leadAgentId: null,
      language: '繁體中文',
      // 不支援 resume 的成員每回合都要重送對話紀錄,超過這個字元數就截斷中段,避免撞上 context 上限
      maxTranscriptChars: 60000,
      // 自動驗證指令:預設空的(只做內建語法檢查)。設了就在執行與修復後跑,結果交給審查與修復
      verifyCommand: '',
      // 工作模式:預設寫程式(這是目前最常見的用法);一般任務不做語法檢查與測試鎖
      workStyle: 'code',
    },
  };
}

class Store {
  userDataDir: string;
  file: string;
  config: AppConfig;

  constructor(userDataDir: string) {
    this.userDataDir = userDataDir;
    this.file = path.join(userDataDir, 'config.json');
    this.config = this.load();
  }
  load(): AppConfig {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      const def = defaultConfig();
      const agents = Array.isArray(raw.agents) ? raw.agents : def.agents;
      const settings = { ...def.settings, ...(raw.settings || {}) };
      // 接力已併入多 AI 把關;不足三位成員時退回平行分工
      if (settings.mode === 'relay') settings.mode = agents.filter((agent: { enabled?: boolean }) => agent.enabled !== false).length >= 3 ? 'guarded' : 'divide';
      return { agents, settings, lineups: sanitizeLineups(raw.lineups) };
    } catch {
      return defaultConfig();
    }
  }
  save(config: AppConfig): AppConfig {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(config, null, 2));
    this.config = config;
    return this.config;
  }
  get(): AppConfig { return this.config; }
}

export { Store, defaultConfig };
