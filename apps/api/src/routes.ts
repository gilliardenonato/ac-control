import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { CommandRequestSchema, CommandSchema, DeviceSchema, HistoryQuerySchema } from "@acc/contracts";
import type { Core } from "./core.ts";
import type { DeviceDto } from "@acc/contracts";

export function toDeviceDto(core: Core, id: string): DeviceDto {
  const d = core.deviceOrThrow(id);
  const st = core.states.get(id);
  return { id, name: d.name, model: d.model, state: st.values as any, observedAt: st.observedAt as Record<string, number>, capabilities: core.cachedCapabilities(id) ?? null, breaker: core.gateway.breakerOpen(id) };
}

const problem = (status: number, title: string, extra: object = {}) => ({ type: "about:blank", title, status, ...extra });

export function registerRoutes(app0: FastifyInstance, core: Core) {
  const app = app0.withTypeProvider<ZodTypeProvider>();
  const idParam = z.object({ id: z.string() });

  app.get("/api/v1/devices", { schema: { tags: ["devices"], response: { 200: z.array(DeviceSchema) } } },
    async () => core.store.devices().map((d) => toDeviceDto(core, d.id)));

  app.get("/api/v1/devices/:id", { schema: { tags: ["devices"], params: idParam, response: { 200: DeviceSchema, 404: z.any() } } },
    async (req, reply) => { if (!core.store.device(req.params.id)) return reply.status(404).send(problem(404, "Dispositivo não encontrado") as any); return toDeviceDto(core, req.params.id); });

  app.post("/api/v1/devices/:id/commands", {
    schema: { tags: ["commands"], params: idParam, body: CommandRequestSchema, response: { 202: CommandSchema, 200: CommandSchema, 404: z.any(), 422: z.any() } },
  }, async (req, reply) => {
    if (!core.store.device(req.params.id)) return reply.status(404).type("application/problem+json").send(problem(404, "Dispositivo não encontrado"));
    const c = await core.gateway.submit({ deviceId: req.params.id, attributes: req.body.attributes, origin: "manual", idempotencyKey: req.body.idempotencyKey });
    if (c.status === "failed" && c.errorKind === "invalidCommand") return reply.status(422).type("application/problem+json").send(problem(422, "Comando inválido", { detail: c.skipReason ?? undefined, kind: "invalidCommand" }));
    return reply.status(c.status === "pending" ? 202 : 200).send(c as any);
  });

  app.get("/api/v1/devices/:id/commands/:commandId", { schema: { tags: ["commands"], params: z.object({ id: z.string(), commandId: z.string() }), response: { 200: CommandSchema, 404: z.any() } } },
    async (req, reply) => { const c = core.store.command(req.params.commandId); if (!c || c.deviceId !== req.params.id) return reply.status(404).send(problem(404, "Comando não encontrado")); return c as any; });

  app.get("/api/v1/devices/:id/commands", { schema: { tags: ["commands"], params: idParam, querystring: z.object({ limit: z.coerce.number().int().min(1).max(200).optional() }), response: { 200: z.array(CommandSchema) } } },
    async (req) => core.store.commands(req.params.id, req.query.limit ?? 50) as any);

  app.get("/api/v1/devices/:id/history", { schema: { tags: ["history"], params: idParam, querystring: HistoryQuerySchema } }, async (req) => {
    const to = req.query.to ?? core.clock.now(), from = req.query.from ?? to - 24 * 3600_000;
    return core.store.readings(req.params.id, from, to, req.query.limit ?? 5000);
  });

  // SSE com Last-Event-ID
  app.get("/api/v1/events/stream", { schema: { tags: ["events"], hide: false } }, (req, reply) => {
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no" });
    const send = (s: { id: number; at: number; event: { type: string } }) => res.write(`id: ${s.id}\nevent: ${s.event.type}\ndata: ${JSON.stringify({ at: s.at, ...s.event })}\n\n`);
    const last = Number(req.headers["last-event-id"] ?? 0);
    res.write("retry: 3000\n\n");
    if (last) for (const s of core.bus.since(last)) send(s);
    const unsub = core.bus.subscribe(send);
    const hb = setInterval(() => res.write(": hb\n\n"), 25_000);
    req.raw.on("close", () => { clearInterval(hb); unsub(); });
  });
}
