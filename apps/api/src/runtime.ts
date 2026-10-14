import type { Clock } from "@acc/domain";
import { AutomationEngine } from "@acc/automation";
import type { ACProvider } from "@acc/provider-api";
import type { Store } from "@acc/storage";
import { Core } from "./core.ts";
import { EnergySync } from "./energy.ts";
import { Scheduler } from "./scheduler.ts";
import { SessionEngine } from "./sessions.ts";
import { SensorHub } from "./sensors.ts";
import type { Sessions } from "./auth.ts";

/** Liga núcleo, engine, sessões, energia e agendador (sem timers; quem chama agenda `scheduler.runDue`). */
export function createRuntime(o: { store: Store; provider: ACProvider; clock: Clock; tz: string; sensorFetch?: typeof fetch; sleep?: (ms: number) => Promise<void>; sessions?: Sessions; retention?: () => void }) {
  const core = new Core(o.store, o.provider, o.clock, { sleep: o.sleep });
  const sensors = new SensorHub(o.store, core.bus, o.clock, o.sensorFetch);
  const engine = new AutomationEngine({
    store: o.store, gateway: core.gateway, clock: o.clock, tz: o.tz,
    state: (id) => core.states.get(id), powerSince: (id) => core.states.powerSince(id),
    emit: (e) => core.bus.publish(e), sensorTemp: (id) => sensors.tempOf(id),
  });
  sensors.onReading(() => engine.onSensorReading());
  const sessions = new SessionEngine(o.store, core, core.bus, o.clock);
  const energy = new EnergySync(o.store, o.provider, core.bus, o.clock, o.tz, (id) => core.deviceOrThrow(id).externalId);
  const scheduler = new Scheduler({ core, engine, energy, sensors, store: o.store, clock: o.clock, tz: o.tz, sessions: o.sessions, retention: o.retention });
  core.onState((c) => { sessions.onState(c); if (c.external) engine.onExternalChange(c.device.id); engine.onStateChange(c.device.id); });
  core.bus.subscribe((s) => {
    if (s.event.type === "command.status") {
      engine.onCommandStatus(s.event.command);
      // quem mexe no aparelho pelo painel assume o controle: pausa as regras do aparelho (override), como já ocorre com mudanças feitas no app da LG/controle
      if (s.event.command.origin === "manual" && s.event.command.status === "sent") engine.onExternalChange(s.event.command.deviceId);
    }
    if (s.event.type === "breaker.open") engine.onBreakerOpen(s.event.deviceId, s.event.reason);
  });
  return { core, engine, energy, scheduler, sessions, sensors, domain: { core, engine, energy, sensors, tz: o.tz } };
}
