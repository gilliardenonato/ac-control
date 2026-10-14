import type { CommandRow } from "@acc/storage";
import type { NormalizedState, ProviderHealth, StateField } from "@acc/domain";

export type AppEvent =
  | { type: "device.state"; deviceId: string; state: NormalizedState; observedAt: Record<string, number>; changed: StateField[]; source: string }
  | { type: "command.status"; command: CommandRow }
  | { type: "provider.health"; health: ProviderHealth }
  | { type: "device.external-change"; deviceId: string; changed: StateField[] }
  | { type: "session.opened" | "session.closed"; deviceId: string; sessionId: string }
  | { type: "automation.state"; ruleId: string; deviceId: string; state: string; reason?: string }
  | { type: "breaker.open"; deviceId: string; reason: string }
  | { type: "energy.updated"; deviceId: string }
  | { type: "sensor.reading"; sensorId: string };

export type Stamped = { id: number; at: number; event: AppEvent };

/** Barramento interno com buffer circular para SSE (Last-Event-ID). */
export class Bus {
  private seq = 0;
  private ring: Stamped[] = [];
  private subs = new Set<(s: Stamped) => void>();
  constructor(private cap = 500, private now: () => number = Date.now) {}
  publish(event: AppEvent) {
    const s: Stamped = { id: ++this.seq, at: this.now(), event };
    this.ring.push(s); if (this.ring.length > this.cap) this.ring.shift();
    for (const f of this.subs) { try { f(s); } catch { /* um assinante ruim não derruba os outros */ } }
  }
  subscribe(f: (s: Stamped) => void): () => void { this.subs.add(f); return () => this.subs.delete(f); }
  since(id: number): Stamped[] { return this.ring.filter((s) => s.id > id); }
}
