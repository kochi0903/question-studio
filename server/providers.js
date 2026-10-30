import { AppError } from "./errors.js";
import { fail } from "./failures.js";

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";
const NVIDIA_BASE = "https://integrate.api.nvidia.com/v1";
const ASSESSMENT_MODELS = {
  gemini: ["gemini-3.5-flash-lite"],
  nvidia: ["nvidia/nemotron-3.5-lightning-30b-a3b", "bigcode/starcoder2-15b"],
};
const ASSESSMENT_DEFAULTS = {
  gemini: "gemini-3.5-flash-lite",
  nvidia: "nvidia/nemotron-3.5-lightning-30b-a3b",
};

// Retry policy. Only failures where the provider did NOT start work on the
// request are retried: 429 (rate limited), 503 (overloaded) and connection
// errors raised before any response arrived. Timeouts, other 5xx responses and
// validation problems are never retried here, so a billed call is never repeated.
const RETRYABLE_STATUS = new Set([429, 503]);
const DEFAULT_MAX_RETRIES = 2;
const MAX_WAIT_MS = 15000;

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// One JSON line per provider call. Never contains the key, prompt or response body.
function defaultLog(event) {
  if (process.env.QUESTION_STUDIO_LOG === "quiet") return;
  const line = "[provider] " + JSON.stringify(event);
  if (event.ok) console.info(line);
  else console.warn(line);
}

function parseRetryAfterMs(response) {
  const raw = response.headers?.get?.("retry-after");
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(raw);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

// The body is read only to classify the failure. It is never returned to the browser.
async function readDetail(response) {
  if (typeof response.text !== "function") return "";
  try {
    return String(await response.text()).slice(0, 2000);
  } catch {
    return "";
  }
}

function classify(status, detail) {
  if (status === 429) {
    if (/per\s*day|daily|billing|exceeded your current quota/i.test(detail))
      return {
        code: "QUOTA_EXCEEDED",
        http: 429,
        retryable: false,
        message:
          "The provider quota for this key is used up. Wait for it to reset, add billing, or switch provider in Settings.",
      };
    return {
      code: "RATE_LIMITED",
      http: 429,
      retryable: true,
      message: "Provider rate limit reached. Wait a moment and try again.",
    };
  }
  if (
    [401, 403].includes(status) ||
    (status === 400 &&
      /api key not valid|api_key_invalid|invalid api key/i.test(detail))
  )
    return {
      code: "AUTH_INVALID",
      http: 502,
      retryable: false,
      message:
        "Provider rejected the key or model access. Check the key in Settings.",
    };
  if (status === 404)
    return {
      code: "MODEL_UNAVAILABLE",
      http: 502,
      retryable: false,
      message:
        "This model is listed by the provider but is not available at its generation endpoint. Choose another model in Settings.",
    };
  if (status === 402)
    return {
      code: "QUOTA_EXCEEDED",
      http: 502,
      retryable: false,
      message:
        "The provider requires billing or additional credits for this model. Check your provider account or choose another model.",
    };
  if (status === 400 || status === 422)
    return {
      code: "PROVIDER_REJECTED",
      http: 502,
      retryable: false,
      message:
        "The provider rejected this request (" +
        status +
        "). The model may not support structured output; try the recommended model.",
    };
  if (status === 503)
    return {
      code: "PROVIDER_UNAVAILABLE",
      http: 502,
      retryable: true,
      message: "The provider is overloaded right now. Try again shortly.",
    };
  return {
    code: "PROVIDER_ERROR",
    http: 502,
    retryable: false,
    message:
      "Provider request failed (" +
      status +
      "). Try again or choose another model.",
  };
}

export function createProviderClient({
  fetchImpl = fetch,
  timeoutMs = 90000,
  maxRetries = DEFAULT_MAX_RETRIES,
  sleep = defaultSleep,
  onEvent = defaultLog,
} = {}) {
  function check(provider) {
    if (!["gemini", "nvidia"].includes(provider))
      throw new AppError("Choose Gemini or NVIDIA.");
  }
  function emit(event) {
    try {
      onEvent(event);
    } catch {
      // Diagnostics must never break a request.
    }
  }
  function backoffMs(attempt, retryAfterMs) {
    const base = retryAfterMs ?? 1000 * 2 ** attempt;
    return Math.round(base + Math.random() * 250);
  }

  async function request(url, options, meta = {}) {
    for (let attempt = 0; ; attempt++) {
      const started = Date.now();
      const elapsed = () => Date.now() - started;
      let response;
      try {
        response = await fetchImpl(url, {
          ...options,
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        if (["TimeoutError", "AbortError"].includes(error?.name)) {
          emit({ ...meta, ok: false, attempt, code: "TIMEOUT", ms: elapsed() });
          throw fail(
            "Provider request timed out. No questions were returned. Try again, or choose a faster model in Settings.",
            504,
            "TIMEOUT",
          );
        }
        // fetch rejected before any response: nothing was processed upstream.
        const willRetry = attempt < maxRetries;
        emit({
          ...meta,
          ok: false,
          attempt,
          code: "NETWORK",
          ms: elapsed(),
          willRetry,
        });
        if (willRetry) {
          await sleep(backoffMs(attempt));
          continue;
        }
        throw fail(
          "Could not reach the provider. Check your connection and try again.",
          502,
          "NETWORK",
        );
      }

      if (!response.ok) {
        const detail = await readDetail(response);
        const problem = classify(response.status, detail);
        const retryAfterMs = parseRetryAfterMs(response);
        const wait = backoffMs(attempt, retryAfterMs);
        const willRetry =
          problem.retryable &&
          RETRYABLE_STATUS.has(response.status) &&
          attempt < maxRetries &&
          wait <= MAX_WAIT_MS;
        emit({
          ...meta,
          ok: false,
          attempt,
          status: response.status,
          code: problem.code,
          ms: elapsed(),
          willRetry,
        });
        if (willRetry) {
          await sleep(wait);
          continue;
        }
        const extra = {};
        let message = problem.message;
        if (problem.code === "RATE_LIMITED" && retryAfterMs !== undefined) {
          extra.retryAfterSeconds = Math.ceil(retryAfterMs / 1000);
          message =
            "Provider rate limit reached. Try again in about " +
            extra.retryAfterSeconds +
            " seconds.";
        }
        throw fail(message, problem.http, problem.code, extra);
      }

      let data;
      try {
        data = await response.json();
      } catch (error) {
        if (["TimeoutError", "AbortError"].includes(error?.name)) {
          emit({ ...meta, ok: false, attempt, code: "TIMEOUT", ms: elapsed() });
          throw fail(
            "Provider request timed out. No questions were returned. Try again, or choose a faster model in Settings.",
            504,
            "TIMEOUT",
          );
        }
        emit({
          ...meta,
          ok: false,
          attempt,
          code: "UNREADABLE_RESPONSE",
          ms: elapsed(),
        });
        throw fail(
          "Provider returned an unreadable response. Try again.",
          502,
          "UNREADABLE_RESPONSE",
        );
      }
      meta.__result = { attempt, ms: elapsed() };
      return data;
    }
  }

  return {
    async listModels(provider, key) {
      check(provider);
      const headers =
        provider === "nvidia"
          ? { Authorization: "Bearer " + key }
          : { "x-goog-api-key": key };
      const models = [];
      let token;
      let pages = 0;
      do {
        const url =
          (provider === "gemini" ? GEMINI_BASE : NVIDIA_BASE) +
          "/models" +
          (token ? "?pageToken=" + encodeURIComponent(token) : "");
        const data = await request(
          url,
          { headers },
          { operation: "listModels", provider },
        );
        const entries = provider === "gemini" ? data.models : data.data;
        if (!Array.isArray(entries))
          throw fail(
            "Provider returned an invalid model list.",
            502,
            "UNREADABLE_RESPONSE",
          );
        for (const model of entries) {
          if (
            provider === "gemini" &&
            typeof model?.name === "string" &&
            model.supportedGenerationMethods?.includes("generateContent") &&
            !/(?:tts|image|audio|lyria|banana|transcribe|robotics|computer-use|research|antigravity|omni)/i.test(
              model.name,
            )
          )
            models.push({
              id: model.name.replace(/^models\//, ""),
              label: model.displayName || model.name,
            });
          if (
            provider === "nvidia" &&
            typeof model?.id === "string" &&
            !/(?:embed|guard|safety|reward|deplot|diffusion|cosmos|nvclip|riva|nemotron-parse)/i.test(
              model.id,
            )
          )
            models.push({ id: model.id, label: model.id });
        }
        token = provider === "gemini" ? data.nextPageToken : undefined;
        if (++pages >= 20 && token)
          throw fail(
            "Provider returned too many model pages.",
            502,
            "UNREADABLE_RESPONSE",
          );
      } while (token);
      const preferred = ASSESSMENT_DEFAULTS[provider];
      const available = new Map(models.map((model) => [model.id, model]));
      return ASSESSMENT_MODELS[provider]
        .filter((id) => available.has(id))
        .map((id) => {
          const model = available.get(id);
          return id === preferred
            ? {
                ...model,
                label: model.label + " · recommended for assessments",
              }
            : model;
        });
    },

    async generate(
      provider,
      key,
      model,
      prompt,
      { responseSchema, maxOutputTokens = 16384 } = {},
    ) {
      check(provider);
      const gemini = provider === "gemini";
      const url = gemini
        ? GEMINI_BASE +
          "/models/" +
          encodeURIComponent(model) +
          ":generateContent"
        : NVIDIA_BASE + "/chat/completions";
      const nemotron = model === "nvidia/nemotron-3.5-lightning-30b-a3b";
      const body = gemini
        ? {
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            generationConfig: {
              responseMimeType: "application/json",
              temperature: 0.35,
              maxOutputTokens,
              ...(responseSchema ? { responseJsonSchema: responseSchema } : {}),
            },
          }
        : {
            model,
            messages: [{ role: "user", content: prompt }],
            temperature: 0.35,
            max_tokens: Math.min(maxOutputTokens, 8000),
            stream: false,
            ...(nemotron
              ? { chat_template_kwargs: { enable_thinking: false } }
              : {}),
            ...(nemotron && responseSchema
              ? {
                  response_format: {
                    type: "json_schema",
                    json_schema: {
                      name: "assessment_candidates",
                      strict: true,
                      schema: responseSchema,
                    },
                  },
                }
              : {}),
          };
      const meta = { operation: "generate", provider, model };
      const data = await request(
        url,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(gemini
              ? { "x-goog-api-key": key }
              : { Authorization: "Bearer " + key }),
          },
          body: JSON.stringify(body),
        },
        meta,
      );

      const candidate = gemini ? data.candidates?.[0] : data.choices?.[0];
      const finishReason = gemini
        ? candidate?.finishReason
        : candidate?.finish_reason;
      const usage = gemini
        ? {
            inputTokens: data.usageMetadata?.promptTokenCount,
            outputTokens: data.usageMetadata?.candidatesTokenCount,
          }
        : {
            inputTokens: data.usage?.prompt_tokens,
            outputTokens: data.usage?.completion_tokens,
          };
      const outcome = (code) =>
        emit({
          ...Object.fromEntries(
            Object.entries(meta).filter(([name]) => name !== "__result"),
          ),
          ok: !code,
          ...(code ? { code } : {}),
          attempt: meta.__result?.attempt,
          ms: meta.__result?.ms,
          finishReason,
          ...usage,
        });

      if (gemini && data.promptFeedback?.blockReason) {
        outcome("BLOCKED");
        throw fail(
          "The provider blocked this request (" +
            String(data.promptFeedback.blockReason).toLowerCase() +
            "). Adjust the source text and try again.",
          422,
          "BLOCKED",
        );
      }
      if (finishReason === "MAX_TOKENS" || finishReason === "length") {
        outcome("TRUNCATED_OUTPUT");
        throw fail(
          "The model ran out of output space before finishing. Regenerate, or use shorter source text or fewer topics.",
          502,
          "TRUNCATED_OUTPUT",
        );
      }
      if (
        [
          "SAFETY",
          "RECITATION",
          "PROHIBITED_CONTENT",
          "BLOCKLIST",
          "SPII",
          "content_filter",
        ].includes(finishReason)
      ) {
        outcome("BLOCKED");
        throw fail(
          "The provider stopped this response for content reasons. Adjust the source text and try again.",
          422,
          "BLOCKED",
        );
      }

      const content = gemini
        ? candidate?.content?.parts
            ?.filter((part) => !part.thought)
            .map((part) => part.text || "")
            .join("")
        : candidate?.message?.content;
      if (typeof content !== "string" || !content.trim()) {
        outcome("EMPTY_OUTPUT");
        throw fail(
          "Provider returned no question content. Try again or choose another model.",
          502,
          "EMPTY_OUTPUT",
        );
      }
      outcome();
      return content;
    },
  };
}
const client = createProviderClient();
export const listModels = client.listModels;
export const generate = client.generate;
