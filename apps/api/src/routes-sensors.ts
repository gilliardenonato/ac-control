import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { HistoryQuerySchema, SensorCreateSchema, SensorPatchSchema, SensorTestSchema } from "@acc/contracts";
import type { SensorHub } from "./sensors.ts";
import type { Store } from "@acc/storage";

const problem = (status: number, title: string, extra: object = {}) => ({ type: "about:blank", title, status, ...extra });
const idParam = z.object({ id: z.string() });

export function registerSensorRoutes(app0: FastifyInstance, hub: SensorHub, store: Store, now: () => number) {
  const app = app0.withTypeProvider<ZodTypeProvider>();

  app.get("/api/v1/sensors", { schema: { tags: ["sensors"], response: { 200: z.array(z.any()) } } }, async () => hub.list());

  // testa a URL sem salvar (mostra a leitura que o AC Control enxerga)
  app.post("/api/v1/sensors/test", { schema: { tags: ["sensors"], body: SensorTestSchema, response: { 200: z.any() } } }, async (req) => {
    try { return { ok: true, reading: await hub.test(req.body.pollUrl) }; }
    catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
  });

  app.post("/api/v1/sensors", { schema: { tags: ["sensors"], body: SensorCreateSchema, response: { 201: z.any(), 422: z.any() } } }, async (req, reply) => {
    if (req.body.deviceId && !store.device(req.body.deviceId)) return reply.status(422).type("application/problem+json").send(problem(422, "deviceId inexistente"));
    try { await hub.test(req.body.pollUrl); }
    catch (e) { return reply.status(422).type("application/problem+json").send(problem(422, `Não consegui ler o sensor: ${e instanceof Error ? e.message : e}`)); }
    const s = store.createSensor(req.body.name, req.body.pollUrl, req.body.deviceId ?? null, now());
    await hub.poll(s); // primeira leitura já
    return reply.status(201).send(hub.dto(store.sensor(s.id)!));
  });

  app.patch("/api/v1/sensors/:id", { schema: { tags: ["sensors"], params: idParam, body: SensorPatchSchema, response: { 200: z.any(), 404: z.any() } } }, async (req, reply) => {
    if (!store.sensor(req.params.id)) return reply.status(404).type("application/problem+json").send(problem(404, "Sensor não encontrado"));
    store.updateSensor(req.params.id, req.body);
    return hub.dto(store.sensor(req.params.id)!);
  });

  app.delete("/api/v1/sensors/:id", { schema: { tags: ["sensors"], params: idParam } }, async (req, reply) => {
    const used = store.rules().filter((r) => JSON.stringify(r.definition).includes(`"sensor":"${req.params.id}"`));
    if (used.length) return reply.status(409).type("application/problem+json").send(problem(409, `Sensor em uso pelas automações: ${used.map((u) => u.name).join(", ")}`));
    store.deleteSensor(req.params.id); return reply.status(204).send();
  });

  app.get("/api/v1/sensors/:id/readings", { schema: { tags: ["sensors"], params: idParam, querystring: HistoryQuerySchema } }, async (req) => {
    const to = req.query.to ?? now(), from = req.query.from ?? to - 24 * 3600_000;
    return store.sensorReadings(req.params.id, from, to, req.query.limit ?? 5000);
  });
}
