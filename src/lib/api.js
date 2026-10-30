const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || "").replace(/\/+$/, "");

export const usesExternalApi = Boolean(API_BASE_URL);

export async function api(url, options = {}) {
  let response;
  try {
    const requestUrl = url.startsWith("/")
      ? `${API_BASE_URL}${url}`
      : url;
    response = await fetch(requestUrl, {
      ...options,
      headers: { "Content-Type": "application/json", ...options.headers },
      signal: options.signal || AbortSignal.timeout(120000),
    });
  } catch (error) {
    if (["TimeoutError", "AbortError"].includes(error.name))
      throw new Error("The request timed out. Please try again.");
    throw new Error(
      "Cannot reach Question Studio. Check that the local server is running.",
    );
  }
  const data = await response.json().catch(() => {
    throw new Error("The server returned an unreadable response. Try again.");
  });
  if (!response.ok) throw new Error(data.error || "Something went wrong.");
  return data;
}
