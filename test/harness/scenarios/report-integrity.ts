import assert from 'assert';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { createHash } from 'crypto';
import type { AddressInfo } from 'net';
import { runApp, report } from '../app';
import { scriptedMember } from '../fixtures';
import { appendJournal } from '../../../eval/journal';
import { reportWorksheet, scoreWorksheet } from '../../../eval/report-integrity';
import type { AbTask } from '../../../eval/ab-tasks';

const original = 'module.exports = { value: 0 };\n';
const correct = 'module.exports = { value: 1 };\n';
const broken = 'module.exports = { value: 1;\n';
const longReport = 'Completed answer.js.\n' + 'Evidence retention fixture. '.repeat(100) + 'REPORT_END';
const task: AbTask = {
  id: 'report-integrity-fixture', set: 'basic', asks: 'Preserve evidence through the real app',
  task: 'Update answer.js to export value 1.', entry: 'answer.js',
  files: { 'answer.js': original }, reference: { 'answer.js': correct }, naive: { 'answer.js': original },
  tests: "t('value', () => assert.strictEqual(M().value, 1));",
};

async function main() {
  const payload = 'evidence-\u4e2d\u6587-'.repeat(100_000) + 'RESULT_END';
  const transport = await runApp({
    members: [], timeoutMs: 30_000,
    scenario: async () => ({ payload: 'evidence-\u4e2d\u6587-'.repeat(100_000) + 'RESULT_END' }),
  });
  try {
    assert.ok(transport.ok, `${transport.error}; exit=${transport.exitCode}; stdout bytes=${Buffer.byteLength(transport.stdout)}; expected payload bytes=${Buffer.byteLength(payload)}`);
    assert.strictEqual(transport.value.payload, payload, 'Large UTF-8 scenario results must survive app exit intact');
    console.log('ok - Large UTF-8 scenario result survives Electron exit intact');
  } finally { transport.cleanup(); }
  const failure = await runApp({
    members: [], timeoutMs: 30_000,
    scenario: async () => { throw new Error('fixture scenario failure'); },
  });
  try {
    assert.strictEqual(failure.ok, false);
    assert.strictEqual(failure.exitCode, 1);
    assert.strictEqual(failure.exitSignal, null);
    assert.strictEqual(failure.timedOut, false);
    assert.match(failure.error || '', /fixture scenario failure/);
    console.log('ok - Scenario failure retains its error and nonzero exit code');
  } finally { failure.cleanup(); }
  if (process.argv.includes('--transport-only')) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-report-app-'));
  const evidenceRoot = path.join(dir, 'evidence');
  const journal = path.join(dir, 'runs.journal');
  let writes = 0;
  let breakRepair = false;
  const userAgents: string[] = [];
  const server = http.createServer((request, response) => {
    let raw = '';
    request.on('data', (chunk) => { raw += chunk; });
    request.on('end', () => {
      const send = (code: number, body: unknown) => {
        response.writeHead(code, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify(body));
      };
      try {
        if (request.url === '/v1/models') return send(200, { data: [{ id: 'fixture' }] });
        if (request.url !== '/v1/chat/completions') return send(404, {});
        userAgents.push(String(request.headers['user-agent'] || ''));
        const body = JSON.parse(raw);
        const canWrite = body.tools?.some((tool: any) => tool.function.name === 'write_file');
        const last = body.messages.at(-1);
        const tool = (name: string, args: object) => send(200, { choices: [{ message: {
          role: 'assistant', content: null,
          tool_calls: [{ id: `${name}-${writes}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
        } }] });
        if (canWrite && last.role !== 'tool') return tool('read_file', { path: 'answer.js' });
        if (canWrite && last.role === 'tool' && last.tool_call_id.startsWith('read_file-')) {
          writes++;
          return tool('write_file', {
            path: 'answer.js', content: breakRepair && writes > 1 ? broken : correct,
            expectedSha256: JSON.parse(last.content).sha256, reason: 'Exercise evidence retention',
          });
        }
        return send(200, { choices: [{ message: { role: 'assistant', content: canWrite ? longReport : 'Proceed.\n[AGREED]' } }] });
      } catch (error) { send(500, { error: String(error) }); }
    });
  });
  const envKeys = ['EVAL_CLI', 'EVAL_MODEL', 'EVAL_ADAPTER', 'EVAL_EFFORT', 'EVAL_REVIEWER_CLI', 'EVAL_REVIEWER_MODEL', 'EVAL_REVIEWER_ADAPTER', 'EVAL_EVIDENCE_DIR', 'EVAL_KEEP_DIR'];
  const savedEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const port = (server.address() as AddressInfo).port;
    const adapter = path.join(dir, 'reportfixture.json');
    fs.writeFileSync(adapter, JSON.stringify({
      id: 'reportfixture', type: 'openai', label: 'Report fixture', baseUrl: `http://127.0.0.1:${port}/v1`,
      models: ['fixture'], stream: false, supportsEdit: true, fileTools: { enabled: true },
    }));
    Object.assign(process.env, {
      EVAL_CLI: 'reportfixture', EVAL_MODEL: 'fixture', EVAL_ADAPTER: '', EVAL_EFFORT: '',
      EVAL_REVIEWER_CLI: 'custom', EVAL_REVIEWER_MODEL: '', EVAL_REVIEWER_ADAPTER: '',
      EVAL_EVIDENCE_DIR: evidenceRoot,
    });
    delete process.env.EVAL_KEEP_DIR;
    const { runOnce } = await import('../../../eval/ab');
    for (const condition of ['solo', 'roundtable'] as const) {
      writes = 0;
      breakRepair = condition === 'roundtable';
      let workDir = '';
      let transcript: any[] = [];
      const result = await runOnce(task, condition, 1, 'fixture', async (options) => {
        const scenario = String(options.scenario);
        const app = await runApp({
          ...options,
          members: options.members.map((member) => member.id === 'rev' ? scriptedMember({
            id: 'rev', name: member.name, review: 'Please repair answer.js.',
            recheck: 'answer.js still has a syntax error; the completion claim is not supported.',
          }) : member),
          adapters: [adapter], timeoutMs: 180_000,
          scenario: `const value = await (${scenario})(H); await shot('result'); return value;`,
        });
        assert.ok(report(`Report evidence ${condition}`, { ...app, value: { messages: app.value?.evidenceTranscript?.length } }), app.error);
        workDir = app.workDir;
        transcript = app.value.evidenceTranscript;
        const expected = breakRepair ? broken : correct;
        assert.strictEqual(app.read('answer.js'), expected, 'Independent disk check');
        const audits = transcript.filter((message) => message.tag === 'tool-audit').flatMap((message) => message.toolAudit || []);
        const written = audits.filter((audit) => audit.tool === 'write_file' && audit.ok !== false && audit.path.endsWith('answer.js'));
        assert.strictEqual(written.length, breakRepair ? 2 : 1, 'Execute and repair audits reach the transcript');
        assert.strictEqual(written.at(-1).shaAfter, createHash('sha256').update(expected).digest('hex'));
        const [added, removed] = app.numstat().split('\t');
        assert.strictEqual(Number(added), written.at(-1).added, 'Git additions match the audit');
        assert.strictEqual(Number(removed), written.at(-1).removed, 'Git removals match the audit');
        return app;
      });
      assert.strictEqual(result.error, false);
      assert.strictEqual(result.execFailed, false);
      assert.strictEqual(result.pass, breakRepair ? 0 : 1);
      assert.strictEqual(result.repaired, breakRepair);
      assert.ok(result.evidenceId);
      assert.ok(!fs.existsSync(workDir), 'A/B cleanup removed the original work directory');
      const savedDir = path.join(evidenceRoot, result.evidenceId);
      const evidence = JSON.parse(fs.readFileSync(path.join(savedDir, 'evidence.json'), 'utf8'));
      assert.deepStrictEqual(evidence.transcript, transcript, 'Full IPC messages survive persistence');
      assert.deepStrictEqual(evidence.originalFiles, task.files);
      assert.strictEqual(evidence.model.cli, 'reportfixture');
      assert.strictEqual(evidence.run.score.pass, result.pass);
      assert.strictEqual(fs.readFileSync(path.join(savedDir, 'final', 'answer.js'), 'utf8'), breakRepair ? broken : correct);
      assert.ok(!fs.existsSync(path.join(savedDir, 'final', '.git')));
      const execution = transcript.find((message) => message.kind === 'agent' && message.phase?.code === 'execute');
      assert.strictEqual(execution.text, longReport, 'Report over 1500 characters is not truncated');
      assert.ok(transcript.some((message) => message.tag === 'verify'), 'Automatic verification is preserved');
      const summary = transcript.find((message) => message.tag === 'task-summary');
      assert.strictEqual(summary.taskSummary.verify, breakRepair ? 'failed' : 'passed');
      if (breakRepair) {
        assert.strictEqual(transcript.find((message) => message.kind === 'agent' && message.phase?.code === 'repair').text, longReport);
        assert.strictEqual(summary.taskSummary.repairBroke, true);
      }
      appendJournal(journal, { task: task.id, condition, commit: 'fixture', run: { ...result } });
      console.log(`ok - ${condition}: disk, git, audits, full reports, verification, cleanup and evidence agree`);
    }
    const worksheet = reportWorksheet(journal);
    assert.strictEqual(worksheet.samples.length, 2);
    for (const sample of worksheet.samples) {
      assert.ok(sample.evidenceId && fs.existsSync(path.join(evidenceRoot, sample.evidenceId, 'evidence.json')));
      sample.assessment = {
        verdict: sample.condition === 'solo' ? 'supported' : 'contradicted',
        reportRef: `${sample.evidenceId}/evidence.json#last-executor`,
        evidenceRefs: [`${sample.evidenceId}/final/answer.js`],
        disclosure: sample.condition === 'solo' ? 'unknown' : 'caught',
        disclosureRefs: sample.condition === 'solo' ? [] : [`${sample.evidenceId}/evidence.json#task-summary`],
      };
    }
    const summary = scoreWorksheet(journal, worksheet);
    assert.strictEqual(summary.groups[0].solo.supported, 1);
    assert.strictEqual(summary.groups[0].roundtable.contradicted, 1);
    assert.strictEqual(summary.groups[0].roundtable.caught, 1);
    assert.strictEqual(summary.groups[0].roundtable.unflaggedRate, 0);
    assert.ok(!JSON.stringify(summary).includes(evidenceRoot));
    assert.ok(!JSON.stringify(summary).includes(longReport));
    assert.ok(userAgents.length > 0 && userAgents.every((agent) => agent.includes('Electron/')));
    console.log('ok - Evidence IDs link to offline scoring; shared summary has no transcript or local paths');
    console.log('Report integrity real-app scenarios passed (scripted fixtures, not model experiments).');
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    for (const key of envKeys) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });