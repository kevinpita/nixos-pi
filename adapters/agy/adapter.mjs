import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, copyFile, writeFile, chmod, rm, realpath, readFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { AgyProtocol } from "./protocol.mjs";

const exec = promisify(execFile);
export const MAX_PROMPT = 512 * 1024;
export const SETTINGS = {
  toolPermission: "strict",
  enableTerminalSandbox: true,
  allowNonWorkspaceAccess: false,
  enableTelemetry: false,
  useG1Credits: false,
  permissions: {
    deny: ["read_file(*)", "write_file(*)", "command(*)", "unsandboxed(*)", "read_url(*)", "execute_url(*)", "mcp(*)"],
  },
};

export function validateConfig(config) {
  if (!config || typeof config !== "object" || Array.isArray(config) ||
      Object.keys(config).some((key) => !["model", "effort"].includes(key)) ||
      typeof config.model !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(config.model) ||
      !["low", "medium", "high"].includes(config.effort)) {
    throw new Error("AGY config requires a model slug and low, medium, or high effort, with no other fields");
  }
  return { model: config.model, effort: config.effort };
}

export function sandboxArgs(root, agy, assets, config) {
  const { model, effort } = validateConfig(config);
  return [
    "--die-with-parent", "--unshare-pid", "--unshare-ipc", "--unshare-uts", "--new-session",
    "--ro-bind", "/", "/", "--proc", "/proc", "--dev", "/dev",
    "--tmpfs", "/home", "--tmpfs", "/root", "--tmpfs", "/tmp", "--tmpfs", "/run",
    "--ro-bind", "/run/current-system/sw", "/run/current-system/sw",
    "--bind", join(root, "home"), "/home/agy",
    "--bind", join(root, "workspace"), "/tmp/workspace",
    "--ro-bind", join(root, "settings.json"), "/home/agy/.gemini/antigravity-cli/settings.json",
    "--ro-bind", join(root, "empty"), "/home/agy/.gemini/config",
    "--bind", join(root, "projects"), "/home/agy/.gemini/config/projects",
    "--ro-bind", assets.bin, "/home/agy/.gemini/antigravity-cli/bin",
    "--ro-bind", assets.builtin, "/home/agy/.gemini/antigravity-cli/builtin",
    "--ro-bind", join(root, "keyring-bus"), "/tmp/keyring-bus",
    "--clearenv", "--setenv", "HOME", "/home/agy", "--setenv", "USER", "agy",
    "--setenv", "PATH", "/run/current-system/sw/bin",
    "--setenv", "LANG", "C.UTF-8", "--setenv", "TMPDIR", "/tmp",
    "--setenv", "SSL_CERT_FILE", "/etc/ssl/certs/ca-certificates.crt",
    "--setenv", "AGY_CLI_DISABLE_AUTO_UPDATE", "1",
    "--setenv", "DBUS_SESSION_BUS_ADDRESS", "unix:path=/tmp/keyring-bus",
    "--chdir", "/tmp/workspace", "--", agy,
    "--input-format", "stream-json", "--output-format", "stream-json",
    "--model", model, "--effort", effort, "--disable-slash-commands",
    "--print-timeout", "5m",
  ];
}

export async function collect(command, args, prompt, { model, signal, timeoutMs = 330000 } = {}) {
  const parser = new AgyProtocol("/tmp/workspace", model);
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    let failure;
    let killTimer;
    const fail = (error) => {
      if (failure) return;
      failure = error;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 2000);
    };
    const abort = () => fail(new Error("AGY review cancelled"));
    const timer = setTimeout(() => fail(new Error("AGY review timed out")), timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (text) => {
      if (failure) return;
      try { parser.push(text); } catch (error) { fail(error); }
    });
    // Drain bounded diagnostics without exposing prompts or authentication data.
    let stderrBytes = 0;
    child.stderr.on("data", (data) => {
      stderrBytes += data.length;
      if (stderrBytes > 1024 * 1024) fail(new Error("AGY diagnostics exceed the limit"));
    });
    child.on("error", fail);
    child.stdin.on("error", (error) => fail(new Error(`AGY input failed: ${error.code}`)));
    child.on("close", (code, sig) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      signal?.removeEventListener("abort", abort);
      if (failure) return reject(failure);
      try { resolve(parser.finish(code, sig)); } catch (error) { reject(error); }
    });
    child.stdin.end(JSON.stringify({ event: "user", message: { content: prompt } }) + "\n");
  });
}

export async function startKeyringProxy(command, address, socket, signal) {
  if (!address) throw new Error("AGY requires an existing desktop keyring session");
  const child = spawn(command, ["--fd=3", address, socket, "--filter", "--talk=org.freedesktop.secrets"], {
    stdio: ["ignore", "ignore", "ignore", "pipe"],
  });
  const closed = new Promise((resolve) => child.once("close", resolve));
  const stop = async () => {
    child.stdio[3].destroy();
    child.kill("SIGTERM");
    const killTimer = setTimeout(() => child.kill("SIGKILL"), 2000);
    try { await closed; } finally { clearTimeout(killTimer); }
  };
  try {
    await new Promise((resolve, reject) => {
      const clear = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); };
      const timer = setTimeout(() => { clear(); reject(new Error("Keyring proxy startup timed out")); }, 10000);
      const abort = () => { clear(); reject(new Error("AGY review cancelled")); };
      child.once("error", (error) => { clear(); reject(error); });
      child.once("exit", () => { clear(); reject(new Error("Keyring proxy exited before readiness")); });
      child.stdio[3].once("data", () => { clear(); resolve(); });
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) { clear(); abort(); }
    });
    return stop;
  } catch (error) {
    await stop();
    throw error;
  }
}

export async function review(prompt, { agy, bwrap, dbusProxy, config, home = homedir(), signal } = {}) {
  if (process.platform !== "linux") throw new Error("The AGY adapter requires Linux bubblewrap");
  if (!prompt?.trim() || Buffer.byteLength(prompt) > MAX_PROMPT) throw new Error("Supply a non-empty handoff of at most 512 KiB");
  if (signal?.aborted) throw new Error("AGY review cancelled");
  const selection = validateConfig(config);
  const options = { timeout: 10000, maxBuffer: 128 * 1024, signal };
  const version = await exec(agy, ["--version"], options);
  // Safety and wire format are tested for this version only. Re-test upgrades.
  if (version.stdout.trim() !== "1.2.3") throw new Error("AGY adapter requires tested CLI version 1.2.3");
  const help = await exec(agy, ["--help"], options);
  for (const flag of ["--input-format", "--output-format", "--model", "--effort", "--disable-slash-commands", "--print-timeout"]) {
    if (!(help.stdout + help.stderr).includes(flag)) throw new Error(`AGY lacks required flag ${flag}`);
  }
  await exec(bwrap, ["--version"], options);
  const state = join(home, ".gemini/antigravity-cli");
  const assets = { bin: await realpath(join(state, "bin")), builtin: await realpath(join(state, "builtin")) };
  const root = await mkdtemp(join(tmpdir(), "pi-agy-review-"));
  let stopProxy;
  try {
    const privateState = join(root, "home/.gemini/antigravity-cli");
    await mkdir(privateState, { recursive: true, mode: 0o700 });
    await mkdir(join(root, "workspace"), { mode: 0o700 });
    await mkdir(join(root, "empty/projects"), { recursive: true, mode: 0o700 });
    await mkdir(join(root, "projects"), { mode: 0o700 });
    // Copy only onboarding state, never user settings, hooks, plugins, or conversations.
    // OAuth uses the filtered Secret Service proxy, not these state files.
    for (const file of ["jetski_state.pbtxt", "installation_id"]) {
      const target = join(privateState, file);
      await copyFile(join(state, file), target);
      await chmod(target, 0o600);
    }
    await writeFile(join(root, "settings.json"), JSON.stringify(SETTINGS), { mode: 0o600 });
    if (signal?.aborted) throw new Error("AGY review cancelled");
    stopProxy = await startKeyringProxy(dbusProxy, process.env.DBUS_SESSION_BUS_ADDRESS, join(root, "keyring-bus"), signal);
    return await collect(bwrap, sandboxArgs(root, agy, assets, selection), prompt, { model: selection.model, signal });
  } finally {
    await stopProxy?.();
    await rm(root, { recursive: true, force: true });
  }
}

async function main() {
  // Deployment selects the model and effort. Safety flags stay code-owned.
  const [agy, bwrap, dbusProxy, configPath, ...extra] = process.argv.slice(2);
  if (![agy, bwrap, dbusProxy, configPath].every((path) => path?.startsWith("/")) || extra.length) throw new Error("Usage: adapter.mjs /absolute/agy /absolute/bwrap /absolute/xdg-dbus-proxy /absolute/config.json");
  const config = validateConfig(JSON.parse(await readFile(configPath, "utf8")));
  const controller = new AbortController();
  let reading = true;
  const abort = () => {
    controller.abort();
    if (reading) process.stdin.destroy(new Error("AGY review cancelled"));
  };
  process.on("SIGTERM", abort);
  process.on("SIGINT", abort);
  try {
    const chunks = [];
    let bytes = 0;
    for await (const chunk of process.stdin) {
      bytes += chunk.length;
      if (bytes > MAX_PROMPT) throw new Error("AGY handoff exceeds 512 KiB");
      chunks.push(chunk);
    }
    reading = false;
    const output = await review(Buffer.concat(chunks).toString("utf8"), { agy, bwrap, dbusProxy, config, signal: controller.signal });
    process.stdout.write(output + "\n");
  } finally {
    process.removeListener("SIGTERM", abort);
    process.removeListener("SIGINT", abort);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    // execFile errors can embed raw CLI output. Keep that data out of Pi artifacts.
    const message = error.cmd ? "AGY preflight failed. Check the installed CLI, bubblewrap, and existing AGY login." : error.message;
    process.stderr.write(`Gemini/AGY adapter: ${message}\n`);
    process.exitCode = 1;
  });
}
