export const MAX_OUTPUT = 8 * 1024 * 1024;
export const MAX_LINE = 1024 * 1024;

// No model text is released until both the protocol and process exit succeed.
export class AgyProtocol {
  constructor(cwd, model) {
    if (typeof model !== "string" || !model) throw new Error("An expected AGY model is required");
    this.cwd = cwd;
    this.model = model;
    this.pending = "";
    this.bytes = 0;
    this.id = undefined;
    this.result = undefined;
  }

  push(text) {
    this.bytes += Buffer.byteLength(text);
    if (this.bytes > MAX_OUTPUT) throw new Error("AGY output exceeds the limit");
    this.pending += text;
    let end;
    while ((end = this.pending.indexOf("\n")) !== -1) {
      const line = this.pending.slice(0, end);
      this.pending = this.pending.slice(end + 1);
      this.line(line);
    }
    if (Buffer.byteLength(this.pending) > MAX_LINE) throw new Error("AGY event exceeds the limit");
  }

  line(line) {
    if (!line.trim()) return;
    if (Buffer.byteLength(line) > MAX_LINE) throw new Error("AGY event exceeds the limit");
    if (this.result) throw new Error("AGY sent output after its terminal result");
    let event;
    try { event = JSON.parse(line); } catch { throw new Error("Invalid AGY JSON event"); }
    if (!event || typeof event !== "object" || Array.isArray(event)) throw new Error("Invalid AGY event");
    if (event.event === "init") {
      if (this.id) throw new Error("Duplicate AGY init");
      if (typeof event.conversation_id !== "string" || !event.conversation_id) throw new Error("Missing AGY conversation identity");
      if (event.init?.model !== this.model || !["strict", "request-review", "proceed-in-sandbox", "always-proceed"].includes(event.init?.permission_mode) || event.init?.cwd !== this.cwd) {
        throw new Error("AGY model, permissions, or workspace do not match the adapter contract");
      }
      this.id = event.conversation_id;
      return;
    }
    if (!this.id) {
      if (event.event === "result" && event.result?.status === "ERROR") {
        const auth = /auth|login/i.test(String(event.result.error));
        throw new Error(auth ? "AGY authentication failed. Check the existing AGY login on this host." : "AGY startup failed before init. Check local settings and CLI compatibility.");
      }
      throw new Error("AGY event arrived before init");
    }
    const payload = event[event.event];
    if (!payload || payload.conversation_id !== this.id) throw new Error("AGY conversation identity changed");
    if (event.event === "step_update") {
      if (!["user_input", "agent_response", "checkpoint"].includes(payload.step_type) ||
          payload.tool_info || payload.tool_name || payload.subagent_info) {
        throw new Error("AGY attempted tool or subagent activity in a handoff-only review");
      }
      if (!["ACTIVE", "DONE"].includes(payload.state) || payload.error) throw new Error("AGY step failed");
      return;
    }
    if (event.event !== "result") throw new Error("Unknown AGY event type");
    if (payload.status !== "SUCCESS" || payload.error || payload.num_turns !== 1 ||
        typeof payload.response !== "string" || !payload.response.trim()) {
      throw new Error("AGY did not return one successful, non-empty review");
    }
    this.result = payload;
  }

  finish(exitCode, signal) {
    if (this.pending.trim()) this.line(this.pending);
    this.pending = "";
    if (exitCode !== 0 || signal) throw new Error("AGY process did not exit successfully");
    if (!this.result) throw new Error("AGY ended without a terminal result");
    return this.result.response.trim();
  }
}
