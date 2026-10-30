import { AppError } from "./errors.js";
const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";
const NVIDIA_BASE = "https://integrate.api.nvidia.com/v1";
const ASSESSMENT_MODELS = {
  gemini: ["gemini-3.5-flash-lite"],
  nvidia: [
    "nvidia/nemotron-3.5-lightning-30b-a3b",
    "bigcode/starcoder2-15b",
  ],
};
const ASSESSMENT_DEFAULTS = {
  gemini: "gemini-3.5-flash-lite",
  nvidia: "nvidia/nemotron-3.5-lightning-30b-a3b",
};

export function createProviderClient({
  fetchImpl = fetch,
  timeoutMs = 90000,
} = {}) {
  function check(provider) {
    if (!["gemini", "nvidia"].includes(provider))
      throw new AppError("Choose Gemini or NVIDIA.");
  }
  async function request(url, options) {
    try {
      const response = await fetchImpl(url, {
        ...options,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) {
        // Do not expose upstream response bodies: they can contain request data.
        const message =
          response.status === 429
            ? "Provider rate limit reached. Wait and try again."
            : [401, 403].includes(response.status)
              ? "Provider rejected the key or model access. Check Settings."
              : response.status === 404
                ? 'This model is listed by the provider but is not available at its generation endpoint. Choose another model in Settings.'
                : response.status === 402
                  ? 'The provider requires billing or additional credits for this model. Check your provider account or choose another model.'
                  : `Provider request failed (${response.status}). Try again or choose another model.`;
        throw new AppError(message, response.status === 429 ? 429 : 502);
      }
      try {
        return await response.json();
      } catch (error) {
        if (["TimeoutError", "AbortError"].includes(error.name)) throw error;
        throw new AppError(
          "Provider returned an unreadable response. Try again.",
          502,
        );
      }
    } catch (error) {
      if (error instanceof AppError) throw error;
      if (["TimeoutError", "AbortError"].includes(error.name))
        throw new AppError("Provider request timed out. No questions were returned. Discard this assessment and choose a faster model in Settings, then try again.", 504);
      throw new AppError(
        "Could not reach the provider. Check your connection and try again.",
        502,
      );
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
        const data = await request(url, { headers });
        const entries = provider === "gemini" ? data.models : data.data;
        if (!Array.isArray(entries))
          throw new AppError("Provider returned an invalid model list.", 502);
        for (const model of entries) {
          if (
            provider === "gemini" &&
            typeof model?.name === "string" &&
            model.supportedGenerationMethods?.includes("generateContent") &&
            !/(?:tts|image|audio|lyria|banana|transcribe|robotics|computer-use|research|antigravity|omni)/i.test(model.name)
          )
            models.push({
              id: model.name.replace(/^models\//, ""),
              label: model.displayName || model.name,
            });
          if (provider === "nvidia" && typeof model?.id === "string" && !/(?:embed|guard|safety|reward|deplot|diffusion|cosmos|nvclip|riva|nemotron-parse)/i.test(model.id))
            models.push({ id: model.id, label: model.id });
        }
        token = provider === "gemini" ? data.nextPageToken : undefined;
        if (++pages >= 20 && token)
          throw new AppError("Provider returned too many model pages.", 502);
      } while (token);
      const preferred = ASSESSMENT_DEFAULTS[provider];
      const available = new Map(models.map((model) => [model.id, model]));
      return ASSESSMENT_MODELS[provider]
        .filter((id) => available.has(id))
        .map((id) => {
          const model = available.get(id);
          return id === preferred
            ? { ...model, label: model.label + " · recommended for assessments" }
            : model;
        });
    },
    async generate(provider, key, model, prompt, { responseSchema } = {}) {
      check(provider);
      const gemini = provider === "gemini";
      const url = gemini
        ? GEMINI_BASE +
          "/models/" +
          encodeURIComponent(model) +
          ":generateContent"
        : NVIDIA_BASE + "/chat/completions";
      const body = gemini
        ? {
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            generationConfig: {
              responseMimeType: "application/json",
              temperature: 0.35,
              ...(responseSchema ? { responseJsonSchema: responseSchema } : {}),
            },
          }
        : {
            model,
            messages: [{ role: "user", content: prompt }],
            temperature: 0.35,
            max_tokens: 7000,
            stream: false,
            ...(model === 'nvidia/nemotron-3.5-lightning-30b-a3b' ? { chat_template_kwargs: { enable_thinking: false } } : {}),
            ...(model === 'nvidia/nemotron-3.5-lightning-30b-a3b' && responseSchema ? { response_format: { type: 'json_schema', json_schema: { name: 'assessment_candidates', strict: true, schema: responseSchema } } } : {}),
          };
      const data = await request(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(gemini
            ? { "x-goog-api-key": key }
            : { Authorization: "Bearer " + key }),
        },
        body: JSON.stringify(body),
      });
      const content = gemini
        ? data.candidates?.[0]?.content?.parts
            ?.filter((part) => !part.thought)
            .map((part) => part.text || "")
            .join("")
        : data.choices?.[0]?.message?.content;
      if (typeof content !== "string" || !content.trim())
        throw new AppError(
          "Provider returned no question content. Try another model.",
          502,
        );
      return content;
    },
  };
}
const client = createProviderClient();
export const listModels = client.listModels;
export const generate = client.generate;
