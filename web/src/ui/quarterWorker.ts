/** Dedicated exact-quarter generation; never owns the renderer or the page. */
import { megaQuarterDetail } from '../gen/urban/mega/detail';
import type { World } from '../gen/types';
import type { QuarterRequest, QuarterResult } from './quarterPoolCore';

const ctx = self as unknown as DedicatedWorkerGlobalScope;
let world: World | undefined;
let revision = 0;
ctx.onmessage = (e: MessageEvent<QuarterRequest>): void => {
  const request = e.data;
  if (request.type === 'world') { world = request.world; revision = request.revision; return; }
  const result: QuarterResult = { type: 'quarter', job: request.job, key: request.key, revision: request.revision };
  if (!world || revision !== request.revision) {
    ctx.postMessage({ ...result, error: 'quarter world not ready', fatal: true }); return;
  }
  try {
    result.layer = megaQuarterDetail(world, request.key);
  } catch (error) { result.error = String((error as Error)?.message ?? error); }
  ctx.postMessage(result);
};
