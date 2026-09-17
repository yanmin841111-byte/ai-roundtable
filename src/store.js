'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

function defaultConfig() {
  return {
    agents: [
      {
        id: crypto.randomUUID(),
        name: 'Claude',
        cli: 'claude',
        model: 'opus',
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
        model: 'gpt-5.5',
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
      mode: 'divide',
      leadAgentId: null,
      language: '繁體中文',
    },
  };
}

class Store {
  constructor(userDataDir) {
    this.file = path.join(userDataDir, 'config.json');
    this.config = this.load();
  }
  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      const def = defaultConfig();
      return { agents: Array.isArray(raw.agents) ? raw.agents : def.agents, settings: { ...def.settings, ...(raw.settings || {}) } };
    } catch {
      return defaultConfig();
    }
  }
  save(config) {
    this.config = config;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(config, null, 2));
    return this.config;
  }
  get() { return this.config; }
}

module.exports = { Store, defaultConfig };
