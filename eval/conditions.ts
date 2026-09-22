import { compareGates, type GateState } from '../src/ratchet';
import type { DiscussionMode } from '../src/ipc-types';

export const CONDITIONS = ['solo', 'roundtable', 'independent-first', 'sequential-candidates', 'independent-candidates', 'solo-budget'] as const;
export type Condition = typeof CONDITIONS[number];

export function parseConditions(value: string): Condition[] {
  const conditions = value.split(',').map((item) => item.trim());
  if (conditions.some((item) => !CONDITIONS.includes(item as Condition)) || new Set(conditions).size !== conditions.length) {
    throw new Error(`conditions must be unique members of: ${CONDITIONS.join(', ')}`);
  }
  return conditions as Condition[];
}

export interface Candidate<Value> {
  value: Value;
  gates: GateState;
  tokens: number | null;
  usable: boolean;
}

export interface CandidatePolicy {
  attempts: number;
  visibility: DiscussionMode;
  tokenBudget?: number;
}

export function positiveInteger(value: unknown, name: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw new Error(`${name} must be a positive integer`);
  return number;
}

export function selectCandidate<Value>(current: Candidate<Value> | null, next: Candidate<Value>): boolean {
  if (!next.usable || !next.gates.entries.length) return false;
  if (!current) return true;
  const comparison = compareGates(current.gates, next.gates);
  const missingPassed = current.gates.entries.some((entry) => entry.ok && entry.weight !== 'inherited'
    && !next.gates.entries.some((other) => other.kind === entry.kind && other.key === entry.key));
  return !missingPassed && comparison.verdict === 'improved';
}

export async function runCandidates<Value>(
  policy: CandidatePolicy,
  produce: (index: number, visible: readonly Value[]) => Promise<Candidate<Value>>,
  baseline: Candidate<Value> | null = null,
) {
  const attempts = positiveInteger(policy.attempts, 'attempts');
  if (policy.tokenBudget !== undefined) positiveInteger(policy.tokenBudget, 'tokenBudget');
  const candidates: Array<Candidate<Value>> = [];
  let selected = baseline;
  let selectedIndex: number | null = null;
  let tokens = 0;
  let usageComplete = true;
  for (let index = 0; index < attempts; index++) {
    const visible = policy.visibility === 'sequential' ? candidates.filter((item) => item.usable).map((item) => item.value) : [];
    const candidate = await produce(index, visible);
    candidates.push(candidate);
    if (selectCandidate(selected, candidate)) { selected = candidate; selectedIndex = index; }
    if (candidate.tokens === null || !Number.isFinite(candidate.tokens) || candidate.tokens < 0) usageComplete = false;
    else tokens += candidate.tokens;
    if (policy.tokenBudget !== undefined && (!usageComplete || tokens >= policy.tokenBudget)) break;
  }
  return {
    candidates, selected, selectedIndex,
    budget: {
      target: policy.tokenBudget ?? null,
      tokens: usageComplete ? tokens : null,
      attempts: candidates.length,
      stop: !usageComplete && policy.tokenBudget !== undefined ? 'usage-unavailable' as const
        : policy.tokenBudget !== undefined && tokens >= policy.tokenBudget ? 'target-reached' as const : 'attempt-limit' as const,
    },
  };
}