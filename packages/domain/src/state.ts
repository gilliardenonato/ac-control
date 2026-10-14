import { DeviceState, NormalizedState, STATE_FIELDS, StateField } from "./types.ts";

export const emptyState = (): DeviceState => ({ values: {}, observedAt: {} });

/** Merge por campo: só os campos presentes no evento substituem; ausente = inalterado. */
export function mergeState(cur: DeviceState, patch: NormalizedState, fieldsPresent: StateField[], at: number): DeviceState {
  const values = { ...cur.values };
  const observedAt = { ...cur.observedAt };
  for (const f of STATE_FIELDS) {
    if (fieldsPresent.includes(f) && patch[f] !== undefined) {
      (values as Record<string, unknown>)[f] = patch[f];
      observedAt[f] = at;
    }
  }
  return { values, observedAt };
}

export function changedFields(prev: NormalizedState, next: NormalizedState, fields: StateField[]): StateField[] {
  return fields.filter((f) => next[f] !== undefined && next[f] !== prev[f]);
}

export const ageMs = (s: DeviceState, f: StateField, now: number): number | undefined =>
  s.observedAt[f] === undefined ? undefined : now - s.observedAt[f]!;
