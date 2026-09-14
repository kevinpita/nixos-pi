import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, realpath } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { AgyProtocol } from "./protocol.mjs";

const exec = promisify(execFile);
export const MAX_PROMPT = 512 * 1024;

export function validateConfig(config) {
  if (!config || typeof config !== "object" || Array.isArray(config) ||
      Object.keys(config).some((key) => !["model", "effort"].includes(key)) ||
      typeof config.model !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(config.model) ||
      !["low", "medium", "high"].includes(config.effort)) {
    throw new Error("AGY config requires a model slug and low, medium, or high effort, with no other fields");
  }
  return { model: config.model, effort: config.effort };
}

export function cliArgs(config) {
  const { model, effort } = validateConfig(config);
  return [
    "--input-format", "stream-json", "--output-format", "stream-json",
    "--model", model, "--effort", effort, "--disable-slash-commands",
    "--print-timeout", "5m",
  ];
}

export async function collect(command, args, prompt, { model, cwd, signal, timeoutMs = 330000 } = {}) {
  const parser = new AgyProtocol(cwd, model);
  return await new Promise((resolve, reject) => {
    // Inherit the real home, environment, login, and settings. This is trusted
    // local execution, not a filesystem sandbox. Never copy credentials.
    const child = spawn(command, args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
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

export async function review(prompt, { agy, config, cwd = process.cwd(), signal } = {}) {
  if (!prompt?.trim() || Buffer.byteLength(prompt) > MAX_PROMPT) throw new Error("Supply a non-empty handoff of at most 512 KiB");
  if (signal?.aborted) throw new Error("AGY review cancelled");
  const selection = validateConfig(config);
  const options = { timeout: 10000, maxBuffer: 128 * 1024, signal };
  const version = await exec(agy, ["--version"], options);
  // Wire format is tested for this version only. Re-test upgrades.
  if (version.stdout.trim() !== "1.2.3") throw new Error("AGY adapter requires tested CLI version 1.2.3");
  const help = await exec(agy, ["--help"], options);
  for (const flag of ["--input-format", "--output-format", "--model", "--effort", "--disable-slash-commands", "--print-timeout"]) {
    if (!(help.stdout + help.stderr).includes(flag)) throw new Error(`AGY lacks required flag ${flag}`);
  }
  cwd = await realpath(cwd);
  return await collect(agy, cliArgs(selection), prompt, { model: selection.model, cwd, signal });
}

async function main() {
  const [agy, configPath, ...extra] = process.argv.slice(2);
  if (![agy, configPath].every((path) => path?.startsWith("/")) || extra.length) throw new Error("Usage: adapter.mjs /absolute/agy /absolute/config.json");
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
    const output = await review(Buffer.concat(chunks).toString("utf8"), { agy, config, signal: controller.signal });
    process.stdout.write(output + "\n");
  } finally {
    process.removeListener("SIGTERM", abort);
    process.removeListener("SIGINT", abort);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    // execFile errors can embed raw CLI output. Keep that data out of Pi artifacts.
    const message = error.cmd ? "AGY preflight failed. Check the installed CLI and existing AGY login." : error.message;
    process.stderr.write(`Gemini/AGY adapter: ${message}\n`);
    process.exitCode = 1;
  });
}
