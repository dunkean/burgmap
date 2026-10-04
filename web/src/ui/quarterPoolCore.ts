/** Small worker pool, separate from Vite's worker import so its lifecycle is testable in Node. */
import type { World, UrbanLayer } from '../gen/types';
import type { QuarterExecutor } from './megaQueue';
import { megaHosts } from '../gen/urban/mega/detail';

export type QuarterRequest =
  | { type: 'world'; revision: number; world: World }
  | { type: 'quarter'; revision: number; job: number; key: number };
export interface QuarterResult { type: 'quarter'; revision: number; job: number; key: number; layer?: UrbanLayer | null; error?: string; fatal?: boolean }
export type QuarterWorkerHandle = Pick<Worker, 'postMessage' | 'terminate' | 'onmessage' | 'onerror' | 'onmessageerror'>;
interface Job {
  id: number; key: number; revision: number;
  resolve: (layer: UrbanLayer | null) => void; reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}
interface Slot { worker: QuarterWorkerHandle; revision: number; job?: Job }

/** Retain every urban input (including cost and site fields), omit completed output/terrain analysis. */
export function worldForQuarters(world: World): World {
  const { flow: _f, receiver: _r, filled: _fi, ...terrain } = world.terrain;
  return {
    seed: world.seed, options: world.options, mapSize: world.mapSize,
    terrain: terrain as World['terrain'], site: world.site,
    roads: world.roads, bridges: world.bridges,
    urban: world.urban?.macro ? world.urban : undefined,
    settlements: world.settlements?.map((s) => ({ ...s, urban: s.urban?.macro ? s.urban : undefined })),
    stats: {},
  };
}

export class QuarterPool implements QuarterExecutor {
  readonly concurrency: number;
  private world: World;
  private hosts: ReturnType<typeof megaHosts>;
  private revision = 1;
  private serial = 0;
  private slots: Slot[] = [];
  private stopped = false;

  constructor(world: World, private makeWorker: () => QuarterWorkerHandle, concurrency = 2, private timeoutMs = 60000) {
    this.world = worldForQuarters(world);
    this.hosts = megaHosts(world);
    this.concurrency = Math.max(1, Math.min(2, Math.floor(concurrency) || 1));
  }

  setWorld(world: World): void {
    const hosts = megaHosts(world);
    if (hosts.length === this.hosts.length && hosts.every((h, i) => h.si === this.hosts[i].si && h.M === this.hosts[i].M)) return;
    this.hosts = hosts;
    this.world = worldForQuarters(world);
    this.revision++;
  }

  run(key: number): Promise<UrbanLayer | null> {
    if (this.stopped) return Promise.reject(new Error('quarter workers stopped'));
    return new Promise((resolve, reject) => {
      try {
        let slot = this.slots.find((s) => !s.job);
        if (!slot) {
          if (this.slots.length >= this.concurrency) throw new Error('quarter workers busy');
          const worker = this.makeWorker();
          slot = { worker, revision: 0 };
          this.slots.push(slot);
          const own = slot;
          worker.onmessage = (e: MessageEvent<QuarterResult>): void => this.receive(own, e.data);
          worker.onerror = (): void => this.fail(new Error('quarter worker failed'));
          worker.onmessageerror = (): void => this.fail(new Error('quarter worker message could not be cloned'));
        }
        const id = ++this.serial, revision = this.revision;
        const timer = setTimeout(() => this.fail(new Error('quarter worker timed out')), this.timeoutMs);
        slot.job = { id, key, revision, resolve, reject, timer };
        if (slot.revision !== revision) {
          slot.worker.postMessage({ type: 'world', revision, world: this.world } satisfies QuarterRequest);
          slot.revision = revision;
        }
        slot.worker.postMessage({ type: 'quarter', revision, job: id, key } satisfies QuarterRequest);
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error(String(error)));
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  stop(): void { this.fail(new Error('quarter workers stopped')); }

  private receive(slot: Slot, result: QuarterResult): void {
    const job = slot.job;
    if (this.stopped || !job || result.type !== 'quarter' || result.job !== job.id || result.key !== job.key || result.revision !== job.revision) return;
    if (result.fatal) { this.fail(new Error(result.error ?? 'quarter world not ready')); return; }
    clearTimeout(job.timer); slot.job = undefined;
    // Isolate this quarter; the queue retries it once using the complete original World.
    job.resolve(result.error ? null : result.layer ?? null);
  }

  private fail(error: Error): void {
    this.stopped = true;
    for (const slot of this.slots) {
      if (slot.job) { clearTimeout(slot.job.timer); slot.job.reject(error); slot.job = undefined; }
      slot.worker.terminate();
    }
    this.slots = [];
  }
}
