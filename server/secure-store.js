import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

export function safeSettings(stored) {
  return {
    provider: stored.provider || "gemini",
    model: stored.model || "",
    hasGeminiKey: Boolean(stored.geminiKey),
    hasNvidiaKey: Boolean(stored.nvidiaKey),
  };
}

export function createCredentialStore({
  directory,
  protect = encrypt,
  reveal = decrypt,
}) {
  const storePath = path.join(directory, "credentials.json");
  let queue = Promise.resolve();
  async function readStore() {
    try {
      return JSON.parse(await readFile(storePath, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return {};
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
      return reveal(
        provider === "gemini" ? stored.geminiKey : stored.nvidiaKey,
      );
    },
    saveCredentials({ geminiKey, nvidiaKey, provider, model }) {
      const operation = queue.then(async () => {
        await mkdir(directory, { recursive: true });
        const next = { ...(await readStore()), provider, model };
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
