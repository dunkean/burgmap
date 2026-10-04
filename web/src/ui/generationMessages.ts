import type { GResponse } from './protocol';
import type { WorkerResponse } from './worker';

export interface GenerationMessageHandlers {
  exported(message: Extract<GResponse, { type: 'exported' }>): void;
  quarters(message: Extract<GResponse, { type: 'quartersDone' }>): void;
  capabilities(textMeasure: boolean): void;
}
/** Every typed response is consumed before the legacy whole-World branch, including full-export progress. */
export function legacyGenerationResponse(message: WorkerResponse | GResponse, handlers: GenerationMessageHandlers): WorkerResponse | null {
  if (!('type' in message)) return message;
  if (message.type === 'exported') handlers.exported(message);
  else if (message.type === 'quartersDone') handlers.quarters(message);
  else if (message.type === 'capabilities') handlers.capabilities(message.textMeasure);
  return null;
}

export const canWorkerExport = (kind: 'svg' | 'json', textMeasure: boolean): boolean => kind === 'json' || textMeasure;
