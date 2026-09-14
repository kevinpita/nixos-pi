import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import test from "node:test";
import { cliArgs, collect, validateConfig } from "./adapter.mjs";
import { AgyProtocol } from "./protocol.mjs";

const config = { model: "gemini-3.8-flash-high", effort: "high" };
const adapter = fileURLToPath(new URL("./adapter.mjs", import.meta.url));
const init = (mode = "request-review") => ({ event: "init", conversation_id: "test", init: { cwd: "/workspace", model: config.model, permission_mode: mode } });
const result = { event: "result", result: { conversation_id: "test", status: "SUCCESS", response: "No issues found.", num_turns: 1 } };
const push = (parser, value) => parser.push(JSON.stringify(value) + "\n");

test("normal local login and cwd survive the complete adapter invocation", async () => {
  const root = await mkdtemp(join(tmpdir(), "agy-local-test-"));
  try {
    const home = join(root, "home");
    const state = join(home, ".gemini/antigravity-cli");
    await mkdir(state, { recursive: true });
    await writeFile(join(state, "antigravity-oauth-token"), "fixture-token", { mode: 0o600 });
    await writeFile(join(state, "settings.json"), '{"fixture":true}');
    const executable = join(root, "agy");
    await writeFile(executable, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('1.2.3'); process.exit(0); }
if (args[0] === '--help') { console.log(${JSON.stringify(cliArgs(config).join(" "))}); process.exit(0); }
const assert = require('node:assert/strict');
assert.deepEqual(args, ${JSON.stringify(cliArgs(config))});
assert.equal(process.cwd(), ${JSON.stringify(root)});
assert.equal(process.env.HOME, ${JSON.stringify(home)});
assert.equal(process.env.DBUS_SESSION_BUS_ADDRESS, 'fixture-bus');
assert.equal(fs.readFileSync(process.env.HOME + '/.gemini/antigravity-cli/antigravity-oauth-token', 'utf8'), 'fixture-token');
assert.equal(fs.readFileSync(process.env.HOME + '/.gemini/antigravity-cli/settings.json', 'utf8'), '{"fixture":true}');
let input = '';
process.stdin.on('data', c => input += c);
process.stdin.on('end', () => {
 assert.deepEqual(JSON.parse(input), {event: 'user', message: {content: 'Review supplied text only.'}});
 console.log(JSON.stringify({event:'init', conversation_id:'test', init:{cwd:process.cwd(), model:${JSON.stringify(config.model)}, permission_mode:'request-review'}}));
 console.log(${JSON.stringify(JSON.stringify(result))});
});
`, { mode: 0o700 });
    const configPath = join(root, "config.json");
    await writeFile(configPath, JSON.stringify(config));
    const output = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [adapter, executable, configPath], {
        cwd: root, env: { ...process.env, HOME: home, DBUS_SESSION_BUS_ADDRESS: "fixture-bus" },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "", stderr = "";
      child.stdout.on("data", c => stdout += c);
      child.stderr.on("data", c => stderr += c);
      child.on("error", reject);
      child.on("close", code => code === 0 ? resolve(stdout) : reject(new Error(stderr)));
      child.stdin.end("Review supplied text only.");
    });
    assert.equal(output, "No issues found.\n");
    assert.equal(await readFile(join(state, "antigravity-oauth-token"), "utf8"), "fixture-token");
    assert.equal(await readFile(join(state, "settings.json"), "utf8"), '{"fixture":true}');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("only known inherited permission modes are accepted", () => {
  for (const mode of ["strict", "request-review", "proceed-in-sandbox", "always-proceed"]) {
    const parser = new AgyProtocol("/workspace", config.model);
    push(parser, init(mode)); push(parser, result);
    assert.equal(parser.finish(0), "No issues found.");
  }
  assert.throws(() => push(new AgyProtocol("/workspace", config.model), init("unknown")), /contract/);
});

test("tool and subagent output still fails closed", () => {
  for (const extra of [{ step_type: "tool" }, { tool_info: {} }, { tool_name: "read_file" }, { subagent_info: {} }]) {
    const parser = new AgyProtocol("/workspace", config.model);
    push(parser, init());
    assert.throws(() => push(parser, { event: "step_update", step_update: { conversation_id: "test", step_type: "agent_response", state: "DONE", ...extra } }), /tool or subagent/);
  }
});

test("wrong model, cwd, missing result, malformed output and failed exit are rejected", () => {
  for (const extra of [{ model: "wrong" }, { cwd: "/wrong" }]) {
    const event = init(); Object.assign(event.init, extra);
    assert.throws(() => push(new AgyProtocol("/workspace", config.model), event), /contract/);
  }
  assert.throws(() => new AgyProtocol("/workspace", config.model).finish(0), /terminal result/);
  assert.throws(() => new AgyProtocol("/workspace", config.model).push("not json\n"), /JSON/);
  const parser = new AgyProtocol("/workspace", config.model);
  push(parser, init()); push(parser, result);
  assert.throws(() => parser.finish(1), /exit successfully/);
});

test("configuration cannot inject CLI options or bypass permissions", () => {
  assert.throws(() => validateConfig({ ...config, model: "--unsafe" }));
  assert.throws(() => validateConfig({ ...config, bypass: true }));
  assert.throws(() => validateConfig({ ...config, effort: "maximum" }));
  assert.ok(!cliArgs(config).includes("--dangerously-skip-permissions"));
  assert.ok(!cliArgs(config).includes("--continue"));
});

test("timeouts and cancellation terminate the child", async () => {
  const options = { model: config.model, cwd: process.cwd() };
  await assert.rejects(collect(process.execPath, ["-e", "process.stdin.resume(); setInterval(()=>{},1000)"], "test", { ...options, timeoutMs: 100 }), /timed out/);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(collect(process.execPath, ["-e", "process.stdin.resume(); setInterval(()=>{},1000)"], "test", { ...options, signal: controller.signal }), /cancelled/);
});
