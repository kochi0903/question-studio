import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as credentials from "./secure-store.js";
import { listModels as defaultListModels } from "./providers.js";
import { createCandidates as defaultCreateCandidates } from "./question-service.js";
import { AppError } from "./errors.js";
import {
  draftTopicMaterial as defaultDraftTopicMaterial,
  suggestTopics as defaultSuggestTopics,
} from "./material-service.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const loopback = (hostname) =>
  ["localhost", "127.0.0.1", "[::1]"].includes(hostname);

function stringField(body, name, { required = false, max = 1000 } = {}) {
  const value = body[name];
  if (value === undefined && !required) return undefined;
  if (
    typeof value !== "string" ||
    value.length > max ||
    (required && !value.trim())
  )
    throw new AppError(`Invalid ${name}.`);
  return value;
}

export function createApp({
  store = credentials,
  listModels = defaultListModels,
  createCandidates = defaultCreateCandidates,
  suggestTopics = defaultSuggestTopics,
  draftTopicMaterial = defaultDraftTopicMaterial,
  distDir = path.join(root, "dist"),
  logger = console,
} = {}) {
  const app = express();
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    res.set({
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "no-referrer",
    });
    if (req.path.startsWith("/api/")) res.set("Cache-Control", "no-store");
    try {
      if (!loopback(new URL(`http://${req.headers.host}`).hostname))
        throw new AppError("Local access only.", 403);
      if (req.headers.origin && !loopback(new URL(req.headers.origin).hostname))
        throw new AppError("Local access only.", 403);
      if (req.headers["sec-fetch-site"] === "cross-site")
        throw new AppError("Local access only.", 403);
    } catch {
      return next(new AppError("Local access only.", 403));
    }
    next();
  });
  app.use(express.json({ limit: "2mb" }));
  app.get("/api/health", (_req, res) => res.json({ status: "ok" }));
  app.get("/api/settings", async (_req, res) =>
    res.json(store.safeSettings(await store.getCredentials())),
  );
  app.use("/api", (req, _res, next) => {
    if (
      ["POST", "PUT"].includes(req.method) &&
      (!req.is("application/json") ||
        !req.body ||
        typeof req.body !== "object" ||
        Array.isArray(req.body))
    )
      return next(new AppError("Send a JSON object.", 415));
    next();
  });
  function providerFrom(body) {
    if (!["gemini", "nvidia"].includes(body.provider))
      throw new AppError("Choose Gemini or NVIDIA.");
    return body.provider;
  }
  async function keyFrom(body, provider) {
    const supplied = stringField(body, "apiKey", { max: 4096 });
    const key =
      supplied?.trim() ||
      (await store.getApiKey(await store.getCredentials(), provider));
    if (!key) throw new AppError("Add your API key in Settings first.");
    return key;
  }
  app.put("/api/settings", async (req, res) => {
    const provider = providerFrom(req.body);
    const model = stringField(req.body, "model", {
      required: true,
      max: 300,
    }).trim();
    const geminiKey = stringField(req.body, "geminiKey", { max: 4096 });
    const nvidiaKey = stringField(req.body, "nvidiaKey", { max: 4096 });
    res.json(
      await store.saveCredentials({ provider, model, geminiKey, nvidiaKey }),
    );
  });
  app.post("/api/models", async (req, res) => {
    const provider = providerFrom(req.body);
    res.json({
      models: await listModels(provider, await keyFrom(req.body, provider)),
    });
  });
  app.post("/api/material/suggest", async (req, res) => {
    const provider = providerFrom(req.body);
    const model = stringField(req.body, "model", { required: true, max: 300 }).trim();
    const topicInput = stringField(req.body, "topicInput", { required: true, max: 5000 }).trim();
    const sourceText = stringField(req.body, "sourceText", { max: 100000 }) || "";
    res.json(await suggestTopics({ provider, model, key: await keyFrom(req.body, provider), topicInput, sourceText }));
  });
  app.post("/api/material/draft", async (req, res) => {
    const provider = providerFrom(req.body);
    const model = stringField(req.body, "model", { required: true, max: 300 }).trim();
    const sourceText = stringField(req.body, "sourceText", { max: 100000 }) || "";
    const topics = req.body.topics;
    if (!Array.isArray(topics) || topics.length > 6 || !topics.every((topic) => typeof topic === "string" && topic.length <= 120))
      throw new AppError("Select valid topics to develop.");
    res.json(await draftTopicMaterial({ provider, model, key: await keyFrom(req.body, provider), sourceText, topics }));
  });
  app.post("/api/generate", async (req, res) => {
    const body = req.body;
    const provider = providerFrom(body);
    const model = stringField(body, "model", {
      required: true,
      max: 300,
    }).trim();
    const sourceText = stringField(body, "sourceText", {
      required: true,
      max: 100000,
    }).trim();
    const feedback = stringField(body, "feedback", { max: 4000 });
    const selectedTopics = body.selectedTopics ?? [];
    if (
      !Array.isArray(selectedTopics) ||
      selectedTopics.length > 20 ||
      !selectedTopics.every(
        (topic) => typeof topic === "string" && topic.trim() && topic.length <= 120,
      )
    )
      throw new AppError("Choose up to 20 valid assessment topics.");
    if (!["mcq", "truefalse", "coding"].includes(body.type))
      throw new AppError("Unknown question category.");
    if (body.single !== undefined && typeof body.single !== "boolean")
      throw new AppError("single must be a boolean.");
    res.json(
      await createCandidates({
        provider,
        key: await keyFrom(body, provider),
        model,
        type: body.type,
        sourceText,
        feedback,
        single: body.single ?? false,
        selectedTopics,
      }),
    );
  });
  app.use("/api", (_req, res) =>
    res.status(404).json({ error: "Unknown endpoint." }),
  );
  app.use(express.static(distDir));
  app.use((req, res, next) =>
    req.method === "GET"
      ? res.sendFile(
          path.join(distDir, "index.html"),
          (error) => error && next(error),
        )
      : res.status(404).json({ error: "Not found." }),
  );
  app.use((error, _req, res, _next) => {
    if (error.type === "entity.parse.failed")
      return res.status(400).json({ error: "Invalid JSON body." });
    if (error.type === "entity.too.large")
      return res.status(413).json({ error: "Request is too large." });
    if (error instanceof AppError)
      return res.status(error.status).json({ error: error.message });
    logger.error("Question Studio request failed:", error.name);
    res
      .status(500)
      .json({
        error:
          "The request could not be completed. Check the server and try again.",
      });
  });
  return app;
}
