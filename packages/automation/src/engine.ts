import { inTimeWindow, isoWeekday } from "@acc/domain";
import type { Action, AttributePatch, Clock, Condition, DeviceState, Op, RuleDefinition } from "@acc/domain";
import type { RuleRow, Store } from "@acc/storage";
import type { CommandGateway } from "./gateway.ts";

export type RuleStateName = "IDLE" | "ARMED" | "RUNNING" | "COOLDOWN" | "SUSPENDED";
type Tri = boolean | null; // null = desconhecido (sensor velho/ausente)

interface Ctx {
  condSince: Record<string, number>;
  step: number;              // índice da próxima ação de `actions`
  waitUntil?: number;
  runUntil?: number;
  runId?: string;
  runStartedAt?: number;
  startConfirmed?: boolean;
  ending?: { reason: string; force: boolean; since: number; attempts: number; lastSubmitAt?: number };
  reason?: string;
}
const newCtx = (): Ctx => ({ condSince: {}, step: 0 });

export interface EngineDeps {
  store: Store;
  gateway: CommandGateway;
  clock: Clock;
  tz: string;
  state(deviceId: string): DeviceState;
  /** Última temperatura de um sensor externo (valor e instante da leitura). */
  sensorTemp?(sensorId: string): { value: number; at: number } | undefined;
  powerSince(deviceId: string): number | undefined;
  emit(e: { type: "automation.state"; ruleId: string; deviceId: string; state: string; reason?: string }): void;
  staleAfterMs?: number;
  /** Idade máxima de uma leitura de sensor externo (padrão 5 min). */
  sensorStaleAfterMs?: number;
}

const END_TEXT: Record<string, string> = { until: "temperatura de saída atingida", done: "ação concluída", maxRuntime: "tempo máximo atingido", runFor: "tempo definido terminou", overridden: "você assumiu o controle", preempted: "outra regra assumiu", device_off: "aparelho foi desligado", end_failed: "não conseguiu encerrar" };
const cmp = (a: number, op: Op, b: number) => op === ">=" ? a >= b : op === "<=" ? a <= b : op === ">" ? a > b : op === "<" ? a < b : Math.abs(a - b) < 1e-9;

/** Avalia condição em lógica ternária. `since` rastreia há quanto tempo cada `temp` com forSec é verdadeira. */
export function evalCondition(c: Condition, env: { now: number; tz: string; state: DeviceState; powerSince?: number; staleAfterMs: number; sensorStaleAfterMs?: number; sensorTemp?: (id: string) => { value: number; at: number } | undefined }, since: Record<string, number>, key: string, acc: { pending: boolean }): Tri {
  switch (c.type) {
    case "temp": {
      // fonte da temperatura: sensor externo (ex.: ESP32 na sala) ou o sensor do próprio aparelho
      const ext = c.sensor ? env.sensorTemp?.(c.sensor) : undefined;
      const t = c.sensor ? ext?.value : env.state.values.currentTemp, at = c.sensor ? ext?.at : env.state.observedAt.currentTemp;
      const limit = c.sensor ? env.sensorStaleAfterMs ?? env.staleAfterMs : env.staleAfterMs; // sensor externo é consultado a cada 30 s: leitura velha vale pouco
      if (t === undefined || at === undefined || env.now - at > limit) { delete since[key]; return null; }
      if (!cmp(t, c.op, c.value)) { delete since[key]; return false; }
      if (!c.forSec) return true;
      const s = (since[key] ??= env.now);
      if (env.now - s >= c.forSec * 1000) return true;
      acc.pending = true; return false;
    }
    case "timeWindow": return inTimeWindow(env.now, c.from, c.to, c.tz ?? env.tz);
    case "weekday": return c.in.includes(isoWeekday(env.now, env.tz));
    case "deviceState": {
      const v = env.state.values;
      if ((c.power !== undefined && v.power === undefined) || (c.mode !== undefined && v.mode === undefined)) return null;
      return (c.power === undefined || v.power === c.power) && (c.mode === undefined || v.mode === c.mode);
    }
    case "onDuration": {
      if (env.state.values.power === undefined) return null;
      if (env.state.values.power === false) return false;
      if (env.powerSince === undefined) return null;
      return cmp((env.now - env.powerSince) / 1000, c.op, c.seconds);
    }
    case "all": {
      let unknown = false;
      for (const [i, x] of c.of.entries()) { const r = evalCondition(x, env, since, `${key}.${i}`, acc); if (r === false) { clearSiblings(since, key, c.of.length, i); return false; } if (r === null) unknown = true; }
      return unknown ? null : true;
    }
    case "any": {
      let unknown = false;
      for (const [i, x] of c.of.entries()) { const r = evalCondition(x, env, since, `${key}.${i}`, acc); if (r === true) return true; if (r === null) unknown = true; }
      return unknown ? null : false;
    }
    case "not": { const r = evalCondition(c.of, env, since, `${key}.n`, acc); return r === null ? null : !r; }
  }
}
/** Quando um irmão de `all` falha, os contadores de duração dos demais não devem seguir acumulando. */
function clearSiblings(since: Record<string, number>, key: string, n: number, failed: number) {
  for (let i = failed + 1; i < n; i++) for (const k of Object.keys(since)) if (k === `${key}.${i}` || k.startsWith(`${key}.${i}.`)) delete since[k];
}

export class AutomationEngine {
  private staleAfterMs: number;
  private chain: Promise<void> = Promise.resolve();
  constructor(private d: EngineDeps) { this.staleAfterMs = d.staleAfterMs ?? 20 * 60_000; }
  /** Aguarda avaliações pendentes (testes/shutdown). */
  idle() { return this.chain; }
  private enqueue(f: () => Promise<void>) { this.chain = this.chain.then(f).catch(() => {}); }

  // ---- acesso a estado persistido ----
  private rules(deviceId?: string) { return this.d.store.rules(deviceId).filter((r) => (r.definition as RuleDefinition)); }
  private st(ruleId: string) { return this.d.store.ruleState(ruleId); }
  private ctx(ruleId: string): Ctx { return (this.st(ruleId)?.context as Ctx | null) ?? newCtx(); }
  private set(rule: RuleRow, state: RuleStateName, ctx: Ctx, untilTs: number | null = null, reason?: string) {
    const prev = this.st(rule.id);
    ctx.reason = reason ?? ctx.reason;
    this.d.store.setRuleState(rule.id, state, prev?.state === state ? prev.since : this.d.clock.now(), untilTs, ctx);
    if (prev?.state !== state) this.d.emit({ type: "automation.state", ruleId: rule.id, deviceId: rule.deviceId, state, reason });
  }
  stateOf(ruleId: string): RuleStateName { return (this.st(ruleId)?.state as RuleStateName) ?? "IDLE"; }
  /** Regras armadas/rodando pedem poll mais frequente. */
  needsFastPoll(deviceId: string): boolean { return this.rules(deviceId).some((r) => r.enabled && ["ARMED", "RUNNING"].includes(this.stateOf(r.id))); }

  summary(deviceId: string) {
    return this.rules(deviceId).map((r) => { const s = this.st(r.id); return { ruleId: r.id, name: r.name, enabled: r.enabled, priority: r.priority, state: (s?.state ?? "IDLE") as RuleStateName, since: s?.since ?? null, untilTs: s?.untilTs ?? null, reason: (s?.context as Ctx | null)?.reason ?? null, runStartedAt: (s?.context as Ctx | null)?.runStartedAt ?? null }; });
  }

  // ---- ciclo ----
  /** Nova leitura de sensor externo: reavalia os aparelhos que têm regras. */
  onSensorReading() { this.tick(); }
  tick() { for (const dev of new Set(this.rules().map((r) => r.deviceId))) this.enqueue(() => this.evaluateDevice(dev)); }
  onStateChange(deviceId: string) { this.enqueue(() => this.evaluateDevice(deviceId)); }

  /** Alteração fora do app: suspende regras do aparelho; não executa onEnd (a pessoa assumiu o controle). */
  onExternalChange(deviceId: string) {
    for (const r of this.rules(deviceId)) {
      if (!r.enabled) continue;
      const def = r.definition as RuleDefinition;
      const c = this.ctx(r.id);
      if (this.stateOf(r.id) === "RUNNING") this.endRun(r, c, "overridden");
      this.set(r, "SUSPENDED", newCtx(), this.d.clock.now() + def.guards.overrideSuspendSec * 1000, "alteração manual/externa");
    }
  }
  /** Breaker aberto: suspende sem prazo até resume manual. */
  onBreakerOpen(deviceId: string, reason: string) {
    for (const r of this.rules(deviceId)) { if (!r.enabled) continue; if (this.stateOf(r.id) === "RUNNING") this.endRun(r, this.ctx(r.id), "breaker"); this.set(r, "SUSPENDED", newCtx(), null, `breaker: ${reason}`); }
  }
  onCommandStatus(cmd: { ruleId: string | null; status: string; errorKind: string | null }) {
    if (!cmd.ruleId || cmd.status !== "failed") return;
    const r = this.d.store.rule(cmd.ruleId); if (!r || this.stateOf(r.id) !== "RUNNING") return;
    const c = this.ctx(r.id);
    const cooldown = this.d.clock.now() + (r.definition as RuleDefinition).guards.cooldownSec * 1000;
    if (c.ending) return; // falha ao encerrar: a verificação por estado no tick reenvia
    this.endRun(r, c, `failed:${cmd.errorKind ?? "erro"}`);
    this.set(r, "COOLDOWN", newCtx(), cooldown, `comando falhou (${cmd.errorKind})`);
  }
  resume(ruleId: string) { const r = this.d.store.rule(ruleId); if (r) this.set(r, "IDLE", newCtx(), null, "retomada manual"); }
  ruleChanged(ruleId: string, reason = "regra editada") {
    const r = this.d.store.rule(ruleId); if (!r) return;
    if (this.stateOf(ruleId) === "RUNNING") this.endRun(r, this.ctx(ruleId), "edited");
    this.set(r, "IDLE", newCtx(), null, reason);
  }

  private async evaluateDevice(deviceId: string) {
    const now = this.d.clock.now();
    const rules = this.rules(deviceId);
    // 1. quem já roda avança primeiro (libera o dono antes de armar outros)
    for (const r of rules) if (r.enabled && this.stateOf(r.id) === "RUNNING") await this.advanceRunning(r, now);
    // 2. restantes, em ordem de prioridade
    for (const r of rules) {
      if (!r.enabled) continue;
      const s = this.stateOf(r.id);
      if (s === "RUNNING") continue;
      if (s === "SUSPENDED") { const u = this.st(r.id)!.untilTs; if (u !== null && now >= u) this.set(r, "IDLE", newCtx(), null, "suspensão expirou"); else continue; }
      if (s === "COOLDOWN") { const u = this.st(r.id)!.untilTs; if (u !== null && now >= u) this.set(r, "IDLE", newCtx()); else continue; }
      await this.evaluateIdle(r, now);
    }
  }

  private env(deviceId: string, now: number) {
    return { now, tz: this.d.tz, state: this.d.state(deviceId), powerSince: this.d.powerSince(deviceId), staleAfterMs: this.staleAfterMs, sensorStaleAfterMs: this.d.sensorStaleAfterMs ?? 5 * 60_000, sensorTemp: this.d.sensorTemp };
  }

  private async evaluateIdle(r: RuleRow, now: number) {
    const def = r.definition as RuleDefinition;
    const ctx = this.ctx(r.id);
    const env = this.env(r.deviceId, now);
    if (env.state.values.online === false) return;
    const acc = { pending: false };
    const res = evalCondition(def.when, env, ctx.condSince, "w", acc);
    if (res !== true) { this.set(r, acc.pending ? "ARMED" : "IDLE", ctx); return; }
    // dono único por aparelho: só inicia se ninguém de prioridade >= roda
    const owner = this.rules(r.deviceId).find((o) => o.id !== r.id && o.enabled && this.stateOf(o.id) === "RUNNING");
    if (owner) {
      if (owner.priority >= r.priority) { this.set(r, "ARMED", ctx, null, `bloqueada por "${owner.name}"`); return; }
      this.endRun(owner, this.ctx(owner.id), "preempted");
      this.set(owner, "COOLDOWN", newCtx(), now + (owner.definition as RuleDefinition).guards.cooldownSec * 1000, `preemptada por "${r.name}"`);
    }
    // inicia execução
    const run = newCtx(); run.runId = this.d.store.startRuleRun(r.id, now); run.runStartedAt = now;
    this.set(r, "RUNNING", run, null, "condição satisfeita");
    await this.advanceRunning(r, now);
  }

  private async advanceRunning(r: RuleRow, now: number) {
    const def = r.definition as RuleDefinition;
    const ctx = this.ctx(r.id);
    const env = this.env(r.deviceId, now);

    if (ctx.ending) { await this.runEnding(r, ctx, now); return; }

    // segurança: tempo máximo
    if (now - (ctx.runStartedAt ?? now) >= def.guards.maxRuntimeSec * 1000) { await this.beginEnding(r, ctx, "maxRuntime", true, now); return; }
    // aparelho desligado por outro meio depois de iniciar (não detectado como externo, ex.: reinício)
    if (ctx.startConfirmed && env.state.values.power === false && def.actions.some((a) => a.type === "setAttributes" && a.power === true)) {
      this.endRun(r, ctx, "device_off"); this.set(r, "COOLDOWN", newCtx(), now + def.guards.cooldownSec * 1000, "aparelho desligado"); return;
    }
    // ações de entrada
    if (ctx.step < def.actions.length) { if (!(await this.runActions(r, def, ctx, now))) return; }
    if (ctx.step < def.actions.length) { this.set(r, "RUNNING", ctx); return; } // aguardando wait

    // condições de saída
    if (ctx.runUntil !== undefined && now >= ctx.runUntil) { await this.beginEnding(r, ctx, "runFor", false, now); return; }
    if (def.until) {
      const acc = { pending: false };
      if (evalCondition(def.until, env, ctx.condSince, "u", acc) === true) { await this.beginEnding(r, ctx, "until", false, now); return; }
    } else if (ctx.runUntil === undefined) { await this.beginEnding(r, ctx, "done", false, now); return; } // ação única
    this.set(r, "RUNNING", ctx);
  }

  /** Executa ações em sequência. Retorna false se a execução foi abortada. */
  private async runActions(r: RuleRow, def: RuleDefinition, ctx: Ctx, now: number): Promise<boolean> {
    while (ctx.step < def.actions.length) {
      const a = def.actions[ctx.step]!;
      if (a.type === "wait") {
        ctx.waitUntil ??= now + a.sec * 1000;
        if (now < ctx.waitUntil) { this.set(r, "RUNNING", ctx); return true; }
        ctx.waitUntil = undefined; ctx.step++; continue;
      }
      if (a.type === "runFor") { ctx.runUntil = now + a.sec * 1000; ctx.step++; continue; }
      const res = await this.submit(r, def, a, false);
      if (res === "blocked") { // guarda impediu o início: volta a IDLE e tenta no próximo tick
        this.endRun(r, ctx, "blocked"); this.set(r, "IDLE", newCtx(), null, "início bloqueado por guarda"); return false;
      }
      if (res === "failed") { this.endRun(r, ctx, "failed:invalid"); this.set(r, "COOLDOWN", newCtx(), now + def.guards.cooldownSec * 1000, "comando inválido"); return false; }
      ctx.step++; ctx.startConfirmed = true;
    }
    return true;
  }

  private async submit(r: RuleRow, def: RuleDefinition, a: Extract<Action, { type: "setAttributes" }>, force: boolean): Promise<"ok" | "blocked" | "failed"> {
    const { type: _t, ...attributes } = a; void _t;
    const row = await this.d.gateway.submit({ deviceId: r.deviceId, attributes: attributes as AttributePatch, origin: `automation:${r.id}`, ruleId: r.id,
      guards: { minOnSec: def.guards.minOnSec, minOffSec: def.guards.minOffSec, maxCommandsPerHour: def.guards.maxCommandsPerHour }, force });
    if (row.status === "failed") return "failed";
    if (row.status === "skipped" && row.skipReason !== "already_in_state") return "blocked";
    return "ok";
  }

  private async beginEnding(r: RuleRow, ctx: Ctx, reason: string, force: boolean, now: number) {
    ctx.ending = { reason, force, since: now, attempts: 0 };
    this.set(r, "RUNNING", ctx, null, `encerrando: ${reason}`);
    await this.runEnding(r, ctx, now);
  }

  /** Encerra só quando o estado confirma o onEnd; reenvia (no máx. 1x/min, 6 tentativas) se não confirmar. */
  private async runEnding(r: RuleRow, ctx: Ctx, now: number) {
    const def = r.definition as RuleDefinition;
    const e = ctx.ending!;
    const acts = (def.onEnd ?? []).filter((a): a is Extract<Action, { type: "setAttributes" }> => a.type === "setAttributes");
    const values = this.d.state(r.deviceId).values;
    const todo = acts.filter((a) => !satisfiedBy(a, values));
    const cooldown = now + def.guards.cooldownSec * 1000;
    if (todo.length === 0) { this.endRun(r, ctx, e.reason); this.set(r, "COOLDOWN", newCtx(), cooldown, `${END_TEXT[e.reason] ?? e.reason}`); return; }
    if (e.attempts >= 6) { this.endRun(r, ctx, "end_failed"); this.set(r, "COOLDOWN", newCtx(), cooldown, "não conseguiu encerrar"); return; }
    if (e.lastSubmitAt !== undefined && now - e.lastSubmitAt < 60_000) { this.set(r, "RUNNING", ctx); return; }
    for (const a of todo) {
      const res = await this.submit(r, def, a, e.force);
      if (res === "blocked") { if (now - e.since > 30 * 60_000) e.force = true; this.set(r, "RUNNING", ctx); return; } // min_on/min_off: tenta no próximo tick; após 30 min força
      if (res === "failed") { this.endRun(r, ctx, "end_failed"); this.set(r, "COOLDOWN", newCtx(), cooldown, "onEnd inválido"); return; }
    }
    e.lastSubmitAt = now; e.attempts++;
    this.set(r, "RUNNING", ctx);
  }

  private endRun(r: RuleRow, ctx: Ctx, outcome: string) {
    if (ctx.runId) this.d.store.endRuleRun(ctx.runId, this.d.clock.now(), outcome);
    ctx.runId = undefined;
  }
}

function satisfiedBy(a: Extract<Action, { type: "setAttributes" }>, v: DeviceState["values"]): boolean {
  return (a.power === undefined || v.power === a.power) && (a.mode === undefined || v.mode === a.mode)
    && (a.targetTemp === undefined || (v.targetTemp !== undefined && Math.abs(v.targetTemp - a.targetTemp) < 0.05)) && (a.fan === undefined || v.fan === a.fan);
}
