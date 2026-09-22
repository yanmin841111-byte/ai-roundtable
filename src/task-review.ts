export interface ReviewTiming {
  version: 1;
  taskId: string;
  deliveredAt: number;
  executionMs: number;
  startedAt: number | null;
  reviewMs: number;
  outcome: 'pending' | 'accepted' | 'incomplete';
  decidedAt: number | null;
  updatedAt: number;
  acceptedEvidence?: string;
}

type TimingStorage = Pick<Storage, 'getItem' | 'setItem'>;
export const REVIEW_TIMING_PREFIX = 'roundtable.review.v1:';

export class ReviewTimer {
  readonly key: string;
  data: ReviewTiming;
  running = false;
  saved = true;
  private lastTick = 0;

  constructor(
    taskId: string,
    deliveredAt: number,
    executionMs: number,
    private storage: TimingStorage,
    private clock: () => number = () => performance.now(),
    private wallClock: () => number = Date.now,
  ) {
    this.key = REVIEW_TIMING_PREFIX + taskId;
    this.data = { version: 1, taskId, deliveredAt, executionMs: Math.max(0, executionMs), startedAt: null, reviewMs: 0, outcome: 'pending', decidedAt: null, updatedAt: this.wallClock() };
    try {
      const raw = JSON.parse(storage.getItem(this.key) || 'null');
      const time = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
      if (raw?.version === 1 && raw.taskId === taskId && raw.deliveredAt === deliveredAt && time(raw.reviewMs)
        && (raw.startedAt === null || time(raw.startedAt)) && (raw.decidedAt === null || time(raw.decidedAt))
        && time(raw.updatedAt) && ['pending', 'accepted', 'incomplete'].includes(raw.outcome)) {
        this.data = { ...this.data, startedAt: raw.startedAt, reviewMs: raw.reviewMs, outcome: raw.outcome, decidedAt: raw.decidedAt, updatedAt: raw.updatedAt };
        if (typeof raw.acceptedEvidence === 'string') this.data.acceptedEvidence = raw.acceptedEvidence;
      }
    } catch { this.saved = false; }
  }

  start(): void {
    if (this.running) return;
    this.data.startedAt ??= this.wallClock();
    this.data.outcome = 'pending';
    this.data.decidedAt = null;
    this.lastTick = this.clock();
    this.running = true;
    this.persist();
  }

  checkpoint(): void {
    if (!this.running) return;
    const now = this.clock();
    this.data.reviewMs += Math.max(0, now - this.lastTick);
    this.lastTick = now;
    this.persist();
  }

  pause(): void {
    this.checkpoint();
    this.running = false;
  }

  decide(outcome: 'accepted' | 'incomplete', evidence?: string): void {
    this.pause();
    this.data.outcome = outcome;
    if (outcome === 'accepted' && evidence) this.data.acceptedEvidence = evidence;
    else delete this.data.acceptedEvidence;
    this.data.decidedAt = this.wallClock();
    this.persist();
  }

  private persist(): void {
    this.data.updatedAt = this.wallClock();
    try { this.storage.setItem(this.key, JSON.stringify(this.data)); this.saved = true; }
    catch { this.saved = false; }
  }
}