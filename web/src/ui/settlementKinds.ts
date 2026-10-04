import { classOfPop } from '../gen/options';
import type { SettlementClass, SettlementSpec } from '../gen/options';

/** UI shortcuts; population remains the only settlement-kind value in the world and shared links. */
export const SETTLEMENT_KINDS: readonly { kind: SettlementClass; label: string; population: number }[] = [
  { kind: 'farmstead', label: 'Farmstead', population: 10 },
  { kind: 'hamlet', label: 'Hamlet', population: 40 },
  { kind: 'village', label: 'Village', population: 300 },
  { kind: 'town', label: 'Town', population: 3000 },
  { kind: 'city', label: 'City', population: 30000 },
  { kind: 'metropolis', label: 'Metropolis', population: 250000 },
  { kind: 'megacity', label: 'Megacity', population: 1500000 },
];

export function withSettlementKind(spec: SettlementSpec, kind: SettlementClass): SettlementSpec {
  if (classOfPop(spec.population) === kind) return spec;
  const choice = SETTLEMENT_KINDS.find((entry) => entry.kind === kind);
  return choice ? { ...spec, population: choice.population } : spec;
}
