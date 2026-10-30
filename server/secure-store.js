import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fail } from "./failures.js";

function powershell(script, input) {
  if (process.platform !== "win32")
    return Promise.reject(
      new Error("Remembered API keys are supported on Windows only."),
    );
  return new Promise((resolve, reject) => {
    // A PowerShell 7 parent may supply incompatible module paths to Windows PowerShell.
    // Use its own security module; keep the existing DPAPI serialization compatible.
    const command =
      "$ErrorActionPreference='Stop'; Import-Module (Join-Path $PSHOME 'Modules\\Microsoft.PowerShell.Security') -ErrorAction Stop; " +
      script;
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", command],
      { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
    );
    let output = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("Windows key protection timed out."));
    }, 15000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.resume();
    child.stdin.on("error", () => {});
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error("Windows key protection failed."));
      else resolve(output.trim());
    });
    child.stdin.end(input);
  });
}
const encrypt = (value) =>
  powershell(
    "$ErrorActionPreference='Stop'; $v=[Console]::In.ReadToEnd(); ConvertTo-SecureString -String $v -AsPlainText -Force | ConvertFrom-SecureString",
    value,
  );
const decrypt = (value) =>
  !value
    ? ""
    : powershell(
        "$ErrorActionPreference='Stop'; $v=[Console]::In.ReadToEnd(); $s=ConvertTo-SecureString -String $v; $b=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($s); try {[Runtime.InteropServices.Marshal]::PtrToStringBSTR($b)} finally {[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b)}",
        value,
      );

// Optional fallback so generation still works where DPAPI is unavailable
// (non-Windows, a broken PowerShell, a profile change that invalidated the store).
// A key saved in Settings always wins over these.
const ENV_KEYS = {
  gemini: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
  nvidia: ["NVIDIA_API_KEY"],
};
function envKey(provider, env = process.env) {
  for (const name of ENV_KEYS[provider] || []) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  return "";
}

export function safeSettings(stored) {
  return {
    provider: stored.provider || "gemini",
    model: stored.model || "",
    hasGeminiKey: Boolean(stored.geminiKey || envKey("gemini")),
    hasNvidiaKey: Boolean(stored.nvidiaKey || envKey("nvidia")),
  };
}

export function createCredentialStore({
  directory,
  protect = encrypt,
  reveal = decrypt,
}) {
  const storePath = path.join(directory, "credentials.json");
  let queue = Promise.resolve();
  // Each decryption starts a PowerShell process (about a second, and it can hit
  // its 15 s limit on a busy machine). Keys rarely change, so decrypt each saved
  // value once per process and share an in-flight decryption between callers.
  // The cache lives only in this process's memory and is cleared on every save.
  const revealed = new Map();

  async function readStore({ tolerant = false } = {}) {
    try {
      return JSON.parse(await readFile(storePath, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return {};
      if (error instanceof SyntaxError) {
        if (tolerant) return {};
        throw fail(
          "The saved settings file is unreadable. Re-enter your provider key in Settings to rebuild it.",
          409,
          "STORE_UNREADABLE",
        );
      }
      throw error;
    }
  }

  return {
    safeSettings,
    async getCredentials() {
      await queue;
      return readStore();
    },
    async getApiKey(stored, provider) {
      const cipher =
        provider === "gemini" ? stored.geminiKey : stored.nvidiaKey;
      if (!cipher) return envKey(provider);
      if (!revealed.has(cipher)) {
        const pending = Promise.resolve()
          .then(() => reveal(cipher))
          .catch(() => {
            revealed.delete(cipher);
            const fallback = envKey(provider);
            if (fallback) return fallback;
            throw fail(
              "The saved key could not be unlocked on this Windows account. Re-enter the key in Settings.",
              409,
              "KEY_UNREADABLE",
            );
          });
        revealed.set(cipher, pending);
        if (revealed.size > 4) revealed.delete(revealed.keys().next().value);
      }
      return revealed.get(cipher);
    },
    saveCredentials({ geminiKey, nvidiaKey, provider, model }) {
      const operation = queue.then(async () => {
        await mkdir(directory, { recursive: true });
        // Saving rebuilds an unreadable file instead of getting stuck behind it.
        const next = {
          ...(await readStore({ tolerant: true })),
          provider,
          model,
        };
        if (geminiKey !== undefined)
          next.geminiKey = geminiKey.trim()
            ? await protect(geminiKey.trim())
            : "";
        if (nvidiaKey !== undefined)
          next.nvidiaKey = nvidiaKey.trim()
            ? await protect(nvidiaKey.trim())
            : "";
        const temporary = storePath + "." + randomUUID() + ".tmp";
        try {
          await writeFile(temporary, JSON.stringify(next, null, 2), {
            mode: 0o600,
            flag: "wx",
          });
          await rename(temporary, storePath);
        } finally {
          await unlink(temporary).catch((error) => {
            if (error.code !== "ENOENT") throw error;
          });
        }
        revealed.clear();
        return safeSettings(next);
      });
      queue = operation.catch(() => {});
      return operation;
    },
  };
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const store = createCredentialStore({ directory: path.join(root, "data") });
export const getCredentials = store.getCredentials;
export const getApiKey = store.getApiKey;
export const saveCredentials = store.saveCredentials;
