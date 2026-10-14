import Fastify, { FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import swagger from "@fastify/swagger";
import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { jsonSchemaTransform, serializerCompiler, validatorCompiler, ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { CommandRequestSchema, HistoryQuerySchema, LoginSchema } from "@acc/contracts";
import type { Core } from "./core.ts";
import { Sessions, safeEqual, verifyPassword } from "./auth.ts";
import type { Config } from "./config.ts";
import { registerRoutes } from "./routes.ts";
import { registerDomainRoutes, type DomainDeps } from "./routes-domain.ts";
import { registerSensorRoutes } from "./routes-sensors.ts";

export const COOKIE = "acc_session";

export interface ServerDeps { core: Core; cfg: Config; domain: DomainDeps }

export async function buildServer({ core, cfg, domain }: ServerDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: cfg.logLevel, redact: ["req.headers.authorization", "req.headers.cookie", "res.headers['set-cookie']"] },
    trustProxy: false,
  }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(helmet, { contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'"], connectSrc: ["'self'"], imgSrc: ["'self'", "data:"] } } });
  await app.register(cookie);
  await app.register(rateLimit, { global: true, max: 600, timeWindow: "1 minute" });
  await app.register(swagger, { openapi: { info: { title: "AC Control API", version: "0.1.0" }, components: {} }, transform: jsonSchemaTransform });

  const sessions = new Sessions(core.store, () => core.clock.now());
  const authRequired = !!(cfg.adminPasswordHash || cfg.apiToken);

  // Erros em RFC 9457
  app.setErrorHandler((err: any, _req, reply) => {
    const status = err.validation || err.code === "FST_ERR_VALIDATION" ? 422 : err.statusCode ?? 500;
    if (status >= 500) app.log.error({ err: { message: err.message } }, "erro interno");
    reply.status(status).type("application/problem+json").send({ type: "about:blank", title: status === 422 ? "Requisição inválida" : status >= 500 ? "Erro interno" : err.message, status, detail: status >= 500 ? undefined : err.message });
  });

  // Autenticação: cookie de sessão (+CSRF por header) ou bearer API_TOKEN
  const PUBLIC = new Set(["/healthz", "/readyz", "/api/v1/auth/login", "/openapi.json"]);
  app.addHook("onRequest", async (req, reply) => {
    const path = req.url.split("?")[0]!;
    if (!authRequired || PUBLIC.has(path) || !path.startsWith("/api/") && !path.startsWith("/metrics")) return;
    const bearer = req.headers.authorization?.startsWith("Bearer ") ? req.headers.authorization.slice(7) : undefined;
    if (bearer && cfg.apiToken && safeEqual(bearer, cfg.apiToken)) return;
    if (sessions.valid(req.cookies[COOKIE])) {
      if (req.method !== "GET" && req.method !== "HEAD" && req.headers["x-requested-with"] !== "acc") return reply.status(403).type("application/problem+json").send({ type: "about:blank", title: "CSRF", status: 403 });
      return;
    }
    return reply.status(401).type("application/problem+json").send({ type: "about:blank", title: "Não autenticado", status: 401 });
  });

  app.get("/healthz", { schema: { hide: true } }, async () => ({ ok: true }));
  app.get("/readyz", { schema: { hide: true } }, async (_r, reply) => {
    let db = true; try { core.store.db.prepare("SELECT 1").get(); } catch { db = false; }
    const prov = core.health.status;
    reply.status(db ? 200 : 503);
    return { db, provider: prov, ready: db };
  });
  app.get("/openapi.json", { schema: { hide: true } }, async () => app.swagger());

  app.post("/api/v1/auth/login", {
    config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
    schema: { body: LoginSchema, tags: ["auth"] },
  }, async (req, reply) => {
    if (!cfg.adminPasswordHash) return reply.status(400).send({ title: "Senha não configurada" });
    if (!verifyPassword(req.body.password, cfg.adminPasswordHash)) return reply.status(401).type("application/problem+json").send({ type: "about:blank", title: "Credenciais inválidas", status: 401 });
    const s = sessions.create();
    reply.setCookie(COOKIE, s.token, { httpOnly: true, sameSite: "strict", secure: cfg.secureCookie, path: "/", expires: new Date(s.expiresAt) });
    return { ok: true };
  });
  app.post("/api/v1/auth/logout", { schema: { tags: ["auth"] } }, async (req, reply) => { sessions.destroy(req.cookies[COOKIE]); reply.clearCookie(COOKIE, { path: "/" }); return { ok: true }; });
  app.get("/api/v1/auth/me", { schema: { tags: ["auth"], response: { 200: z.object({ authenticated: z.boolean(), authRequired: z.boolean() }) } } }, async (req) => ({ authenticated: true, authRequired }));

  registerRoutes(app, core);
  registerDomainRoutes(app as unknown as FastifyInstance, domain);
  registerSensorRoutes(app as unknown as FastifyInstance, domain.sensors, core.store, () => core.clock.now());
  // SPA estática (um container, uma porta)
  if (cfg.webDir && existsSync(resolve(cfg.webDir, "index.html"))) {
    const root = resolve(cfg.webDir);
    await app.register(fastifyStatic, { root }); // wildcard: rebuilds do front não exigem reiniciar
    app.setNotFoundHandler((req, reply) => {
      if (req.method === "GET" && !req.url.startsWith("/api/")) return reply.sendFile("index.html");
      return reply.status(404).type("application/problem+json").send({ type: "about:blank", title: "Não encontrado", status: 404 });
    });
  }
  void CommandRequestSchema; void HistoryQuerySchema;
  return app as unknown as FastifyInstance;
}
