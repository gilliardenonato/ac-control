import { changedFields, emptyState, mergeState } from "./state.ts";
import type { DeviceEvent, DeviceState, NormalizedState, StateField } from "./types.ts";

/** Fonte única do estado atual dos aparelhos, em memória. Aplica merge por campo. */
export class StateStore {
  private states = new Map<string, DeviceState>();
  private powerChangedAt = new Map<string, number>();

  get(deviceId: string): DeviceState { return this.states.get(deviceId) ?? emptyState(); }

  /** Aplica um evento e devolve os campos que realmente mudaram. */
  apply(e: Pick<DeviceEvent, "deviceId" | "receivedAt" | "fieldsPresent" | "normalizedState">): { prev: NormalizedState; changed: StateField[]; powerChanged: boolean } {
    const cur = this.get(e.deviceId);
    const prev = cur.values;
    const next = mergeState(cur, e.normalizedState, e.fieldsPresent, e.receivedAt);
    const changed = changedFields(prev, next.values, e.fieldsPresent);
    this.states.set(e.deviceId, next);
    const powerChanged = changed.includes("power") && prev.power !== undefined;
    // primeira observação não é transição: sem referência, as guardas minOn/minOff não se aplicam
    if (powerChanged) this.powerChangedAt.set(e.deviceId, e.receivedAt);
    return { prev, changed, powerChanged };
  }

  /** Quando o power mudou pela última vez (undefined se nunca observado). */
  powerSince(deviceId: string): number | undefined { return this.powerChangedAt.get(deviceId); }
  /** Restaura o instante (ex.: boot a partir da sessão aberta). */
  setPowerSince(deviceId: string, at: number) { this.powerChangedAt.set(deviceId, at); }
}
