import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '../app';

type Kind = 'pair' | 'trio' | 'complex';
export interface BatchAttempt { id: string; kind: Kind }
export interface BatchRecord extends BatchAttempt {
  passed: boolean;
  evidencePassed: boolean;
  exitCode: number | null;
  sourceHash: string;
  elapsedMs: number;
  error?: string;
}

const MODELS = ['gpt-5-mini', 'claude-haiku-4.5', 'gpt-5.4-mini'];

export function batchPlan(count = 30): BatchAttempt[] {
  if (!Number.isSafeInteger(count) || count < 1) throw new Error('Batch count must be a positive safe integer');
  const kinds = ['pair', 'trio', 'complex'] as const;
  return Array.from({ length: count }, (_, index) => ({ id: String(index + 1).padStart(2, '0'), kind: kinds[index % kinds.length] }));
}

export function batchPassed(records: BatchRecord[], sourceHash: string, count = 30): boolean {
  const plan = batchPlan(count);
  return records.length === plan.length && plan.every((attempt, index) => {
    const record = records[index];
    return record.id === attempt.id && record.kind === attempt.kind && record.passed === true
      && record.evidencePassed === true && record.exitCode === 0 && record.sourceHash === sourceHash;
  });
}

function sourceFingerprint(): string {
  const files = new Set(execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--',
    'main.ts', 'preload.ts', 'src', 'renderer', 'adapters', 'package.json', 'package-lock.json',
    'tsconfig.json', 'tsconfig.build.json', 'test/harness', 'test/copilot.test.ts'], { cwd: REPO_ROOT, encoding: 'utf8' }).split('\0').filter(Boolean));
  const collect = (relative: string) => {
    for (const entry of fs.readdirSync(path.join(REPO_ROOT, relative), { withFileTypes: true })) {
      const file = path.join(relative, entry.name);
      if (entry.isDirectory()) collect(file);
      else if (entry.isFile()) files.add(file);
    }
  };
  collect('dist');
  const hash = createHash('sha256');
  for (const file of [...files].sort()) hash.update(file).update('\0').update(fs.readFileSync(path.join(REPO_ROOT, file))).update('\0');
  return hash.digest('hex');
}

function writeJson(filename: string, value: unknown): void {
  fs.writeFileSync(`${filename}.tmp`, JSON.stringify(value, null, 2));
  fs.renameSync(`${filename}.tmp`, filename);
}

async function execute(attempt: BatchAttempt, directory: string, sourceHash: string): Promise<BatchRecord> {
  const started = Date.now();
  const stdout = fs.openSync(path.join(directory, 'stdout.log'), 'wx');
  const stderr = fs.openSync(path.join(directory, 'stderr.log'), 'wx');
  let exitCode: number | null = null;
  let error: string | undefined;
  try {
    const script = attempt.kind === 'complex' ? 'copilot-complex.ts' : 'copilot-live.ts';
    exitCode = await new Promise<number | null>((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', path.join(__dirname, script), ...(attempt.kind === 'complex' ? ['--continue-plan'] : [])], {
        cwd: REPO_ROOT,
        env: { ...process.env, COPILOT_LIVE: '1', COPILOT_MODELS: MODELS.join(','), COPILOT_TEAM: attempt.kind === 'pair' ? '2' : '3', COPILOT_EVIDENCE_DIR: directory },
        stdio: ['ignore', stdout, stderr],
      });
      child.once('error', reject);
      child.once('close', (code, signal) => { if (signal) error = `Scenario ended with ${signal}`; resolve(code); });
    });
  } catch (reason) { error = String(reason); }
  finally { fs.closeSync(stdout); fs.closeSync(stderr); }
  let evidencePassed = false;
  try {
    const filename = attempt.kind === 'complex' ? 'workflow-evidence.json' : 'live-evidence.json';
    const evidence = JSON.parse(fs.readFileSync(path.join(directory, filename), 'utf8'));
    evidencePassed = evidence.passed === true;
  } catch (reason) { error = `${error || ''} Missing or invalid evidence: ${String(reason)}`.trim(); }
  const currentHash = sourceFingerprint();
  if (currentHash !== sourceHash) error = 'Source or build changed during the run';
  return { ...attempt, sourceHash: currentHash, elapsedMs: Date.now() - started, exitCode, evidencePassed,
    passed: exitCode === 0 && evidencePassed && currentHash === sourceHash && !error, ...(error ? { error } : {}) };
}

async function main() {
  const countIndex = process.argv.indexOf('--count');
  const count = countIndex === -1 ? 30 : Number(process.argv[countIndex + 1]);
  const plan = batchPlan(count);
  const sourceHash = sourceFingerprint();
  const policy = {
    models: MODELS, plan, sourceHash,
    acceptance: `All ${count} scheduled attempts must pass the unchanged scenario acceptance gates. Failures and interrupted attempts count; no replacement runs.`,
    continuation: 'Complex tasks may use the existing plan continuation button once. All approval gates remain required.',
    scope: 'Repeated functional validation of two fixed tasks, not a general model-quality estimate.',
  };
  if (process.argv.includes('--dry-run')) { console.log(JSON.stringify(policy, null, 2)); return; }
  if (process.env.COPILOT_LIVE !== '1') throw new Error('COPILOT_LIVE=1 is required');
  const outputIndex = process.argv.indexOf('--output');
  if (outputIndex === -1 || !process.argv[outputIndex + 1] || process.argv[outputIndex + 1].startsWith('--')) throw new Error('--output <new-directory> is required');
  const output = path.resolve(process.argv[outputIndex + 1]);
  const manifestFile = path.join(output, 'manifest.json');
  if (process.argv.includes('--resume')) {
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    if (JSON.stringify(manifest.policy) !== JSON.stringify(policy)) throw new Error('Cannot resume with changed source, build or policy');
  } else {
    fs.mkdirSync(output);
    fs.writeFileSync(manifestFile, JSON.stringify({ createdAt: new Date().toISOString(), head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim(), policy }, null, 2), { flag: 'wx' });
  }
  const records: BatchRecord[] = [];
  let sourceChanged = false;
  const summarize = () => writeJson(path.join(output, 'summary.json'), {
    planned: plan.length, completed: records.length, passed: records.filter(record => record.passed).length,
    failed: records.filter(record => !record.passed).length, sourceChanged,
    readyToPush: !sourceChanged && batchPassed(records, sourceHash, count), records,
  });
  summarize();
  for (const attempt of plan) {
    const directory = path.join(output, `${attempt.id}-${attempt.kind}`);
    const recordFile = path.join(directory, 'attempt.json');
    if (fs.existsSync(recordFile)) {
      records.push(JSON.parse(fs.readFileSync(recordFile, 'utf8')));
      summarize();
      continue;
    }
    if (fs.existsSync(directory)) {
      const record = { ...attempt, passed: false, evidencePassed: false, exitCode: null, sourceHash, elapsedMs: 0, error: 'Interrupted attempt; not rerun' };
      records.push(record);
      writeJson(recordFile, record);
      summarize();
      continue;
    }
    if (sourceFingerprint() !== sourceHash) { sourceChanged = true; summarize(); break; }
    fs.mkdirSync(directory);
    console.log(`[${attempt.id}/${count}] START ${attempt.kind} ${new Date().toISOString()}`);
    const record = await execute(attempt, directory, sourceHash);
    records.push(record);
    writeJson(recordFile, record);
    sourceChanged = record.sourceHash !== sourceHash;
    summarize();
    console.log(`[${attempt.id}/${count}] ${record.passed ? 'PASS' : 'FAIL'} ${attempt.kind} ${Math.round(record.elapsedMs / 1000)}s; total ${records.filter(item => item.passed).length}/${records.length}`);
    if (sourceChanged) break;
  }
  console.log(`Evidence: ${output}`);
  if (sourceChanged || !batchPassed(records, sourceHash, count)) process.exitCode = 1;
}

if (require.main === module) main().catch((error) => { console.error(error); process.exitCode = 1; });