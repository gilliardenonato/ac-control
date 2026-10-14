// Contratos HTTP compartilhados entre API e web (Zod → OpenAPI).
import { z } from "zod";

export const ModeSchema = z.enum(["cool", "heat", "auto", "fan", "dry"]);
export const AttributePatchSchema = z.object({
  power: z.boolean().optional(),
  mode: ModeSchema.optional(),
  targetTemp: z.number().optional(),
  fan: z.string().optional(),
  swingV: z.boolean().optional(),
  swingH: z.boolean().optional(),
  powerSave: z.boolean().optional(),
}).strict();

export const CommandRequestSchema = z.object({
  attributes: AttributePatchSchema,
  idempotencyKey: z.string().min(1).max(100).optional(),
});

export const CommandSchema = z.object({
  id: z.string(), deviceId: z.string(), createdAt: z.number(), origin: z.string(), ruleId: z.string().nullable(),
  attributes: AttributePatchSchema, status: z.enum(["pending", "sent", "confirmed", "failed", "skipped"]),
  skipReason: z.string().nullable(), errorKind: z.string().nullable(), errorCode: z.string().nullable(),
  sentAt: z.number().nullable(), confirmedAt: z.number().nullable(), latencyMs: z.number().nullable(),
});
export type CommandDto = z.infer<typeof CommandSchema>;

export const StateSchema = z.object({
  power: z.boolean().optional(), mode: ModeSchema.optional(), targetTemp: z.number().optional(),
  currentTemp: z.number().optional(), fan: z.string().optional(), humidity: z.number().optional(), online: z.boolean().optional(),
});
export const DeviceSchema = z.object({
  id: z.string(), name: z.string(), model: z.string().nullable(),
  state: StateSchema, observedAt: z.record(z.string(), z.number()),
  capabilities: z.any(), // Capabilities do domínio
  breaker: z.object({ reason: z.string(), at: z.number() }).nullable(),
});
export type DeviceDto = z.infer<typeof DeviceSchema>;

export const ProblemSchema = z.object({ type: z.string(), title: z.string(), status: z.number(), detail: z.string().optional(), kind: z.string().optional(), errors: z.array(z.string()).optional() });
export const LoginSchema = z.object({ password: z.string().min(1) });
export const HistoryQuerySchema = z.object({ from: z.coerce.number().optional(), to: z.coerce.number().optional(), limit: z.coerce.number().int().min(1).max(20000).optional() });

// ---- Automações ----
const Op = z.enum([">=", "<=", ">", "<", "=="]);
export type ConditionDto =
  | { type: "temp"; op: z.infer<typeof Op>; value: number; forSec?: number; sensor?: string }
  | { type: "timeWindow"; from: string; to: string; tz?: string }
  | { type: "weekday"; in: number[] }
  | { type: "deviceState"; power?: boolean; mode?: string }
  | { type: "onDuration"; op: z.infer<typeof Op>; seconds: number }
  | { type: "all"; of: ConditionDto[] }
  | { type: "any"; of: ConditionDto[] }
  | { type: "not"; of: ConditionDto };
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
export const ConditionSchema: z.ZodType<ConditionDto> = z.lazy(() => z.union([
  z.object({ type: z.literal("temp"), op: Op, value: z.number(), forSec: z.number().int().min(0).max(86400).optional(), sensor: z.string().optional() }),
  z.object({ type: z.literal("timeWindow"), from: hhmm, to: hhmm, tz: z.string().optional() }),
  z.object({ type: z.literal("weekday"), in: z.array(z.number().int().min(1).max(7)).min(1) }),
  z.object({ type: z.literal("deviceState"), power: z.boolean().optional(), mode: z.string().optional() }),
  z.object({ type: z.literal("onDuration"), op: Op, seconds: z.number().min(0) }),
  z.object({ type: z.literal("all"), of: z.array(ConditionSchema).min(1) }),
  z.object({ type: z.literal("any"), of: z.array(ConditionSchema).min(1) }),
  z.object({ type: z.literal("not"), of: ConditionSchema }),
]));
export const ActionSchema = z.union([
  z.object({ type: z.literal("setAttributes") }).extend(AttributePatchSchema.shape).strict(),
  z.object({ type: z.literal("wait"), sec: z.number().int().min(1).max(3600) }),
  z.object({ type: z.literal("runFor"), sec: z.number().int().min(60).max(86400) }),
]);
export const GuardsSchema = z.object({
  maxRuntimeSec: z.number().int().positive(), cooldownSec: z.number().int().min(0), minOnSec: z.number().int().min(0), minOffSec: z.number().int().min(0),
  overrideSuspendSec: z.number().int().min(0), maxCommandsPerHour: z.number().int().positive(),
}).partial(); // o servidor completa com os padrões seguros
export const RuleInputSchema = z.object({
  name: z.string().min(1).max(80), deviceId: z.string(), enabled: z.boolean().default(true), priority: z.number().int().min(0).max(100).default(50),
  when: ConditionSchema, actions: z.array(ActionSchema).min(1), until: ConditionSchema.optional(), onEnd: z.array(ActionSchema).optional(), guards: GuardsSchema.optional(),
});
export type RuleInput = z.infer<typeof RuleInputSchema>;

// ---- Energia / custo ----
export const TariffInputSchema = z.object({ validFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), pricePerKwh: z.number().positive().max(100), note: z.string().max(200).optional() });
export const GoalInputSchema = z.object({ budgetBrl: z.number().positive().max(1_000_000) });
export const EstimateSettingsSchema = z.object({ avgWatts: z.number().positive().max(10000).nullable() });
export const DateRangeQuery = z.object({ from: z.string().regex(/^\d{4}-\d{2}(-\d{2})?$/).optional(), to: z.string().regex(/^\d{4}-\d{2}(-\d{2})?$/).optional(), granularity: z.enum(["day", "month"]).optional() });
export const CostQuery = z.object({ period: z.enum(["today", "yesterday", "week", "month", "range"]).default("month"), from: z.string().optional(), to: z.string().optional() });

// ---- Sensores externos (consultados por HTTP) ----
/** Só http/https, sem credenciais embutidas na URL. */
export const SensorUrlSchema = z.string().url().refine((u) => { try { const x = new URL(u); return (x.protocol === "http:" || x.protocol === "https:") && !x.username && !x.password; } catch { return false; } }, "use uma URL http(s) sem usuário/senha");
export const SensorCreateSchema = z.object({ name: z.string().min(1).max(60), pollUrl: SensorUrlSchema, deviceId: z.string().nullable().optional() });
export const SensorPatchSchema = z.object({ name: z.string().min(1).max(60).optional(), pollUrl: SensorUrlSchema.optional(), deviceId: z.string().nullable().optional() });
export const SensorTestSchema = z.object({ pollUrl: SensorUrlSchema });
