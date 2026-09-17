'use strict';
// 提供給 .js 外掛的工具箱:run(agent, ctx, kit) 的第三個參數。
// 讓外掛不用自己處理行程、逾時、整組終止與模型/強度規則。

const proc = require('./process');
const template = require('./template');
const rules = require('../model-rules');
const { normalizeModels } = require('./spec');

module.exports = {
  runProcess: proc.runProcess,
  checkCli: proc.checkCli,
  parseJson: proc.parseJson,
  truncate: proc.truncate,
  createStopHandle: proc.createStopHandle,
  buildArgs: template.buildArgs,
  render: template.render,
  getPath: template.getPath,
  matches: template.matches,
  normalizeModels,
  findModel: rules.findModel,
  resolveModelId: rules.resolveModelId,
  resolveEffort: rules.resolveEffort,
};
