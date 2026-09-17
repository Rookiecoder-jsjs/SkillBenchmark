#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes("--version")) {
  process.stdout.write("fake-runner 1.0.0\n");
  process.exit(0);
}
const promptIndex = args.indexOf("-p");
const prompt = promptIndex >= 0 ? args[promptIndex + 1] : (args.at(-1) ?? "");
if (prompt.includes("INFRA_RETRY") && process.env.SKILLBENCHMARK_ATTEMPT === "1") {
  process.stderr.write("INFRASTRUCTURE temporary failure\n");
  process.exit(7);
}
if (prompt.includes("HUGE_OUTPUT")) {
  process.stdout.write("x".repeat(5 * 1024 * 1024));
}
if (prompt.includes("TIMEOUT")) {
  setTimeout(() => {}, 10_000);
} else {
  const output = prompt.includes("SKILLBENCHMARK_CONNECTION_OK") ? "SKILLBENCHMARK_CONNECTION_OK" : prompt.includes("REAL_FAIL") ? "wrong" : "real ok";
  if (prompt.includes("CODEX_DIALECT")) {
    process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "codex-thread-test" }) + "\n");
    process.stdout.write(JSON.stringify({ type: "item.started", item: { id: "item-tool", type: "command_execution", command: "pwd" } }) + "\n");
    process.stdout.write(JSON.stringify({ type: "item.completed", item: { id: "item-message", type: "agent_message", text: output } }) + "\n");
    process.stdout.write(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 13, cached_input_tokens: 2, output_tokens: 5 } }) + "\n");
  } else if (prompt.includes("CODEX_FAILED")) {
    process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "codex-thread-failed" }) + "\n");
    process.stdout.write(JSON.stringify({ type: "turn.failed", error: { message: "model unavailable" } }) + "\n");
  } else if (prompt.includes("CLAUDE_DIALECT")) {
    process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "claude-session-test", model: "claude-reported" }) + "\n");
    process.stdout.write(JSON.stringify({ type: "assistant", session_id: "claude-session-test", message: { model: "claude-reported", content: [{ type: "tool_use", name: "Read", input: { file_path: "/fixture" } }] } }) + "\n");
    process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: output, session_id: "claude-session-test", total_cost_usd: 0.004, usage: { input_tokens: 17, output_tokens: 4 } }) + "\n");
  } else if (prompt.includes("PLATFORM_RECEIPT")) {
    process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "session-test", model: "claude-test-actual", access_token: "fixture-sensitive-token" }) + "\n");
    process.stdout.write(JSON.stringify({ type: "result", result: output, session_id: "session-test", total_cost_usd: 0.0123, usage: { input_tokens: 21, output_tokens: 8 } }) + "\n");
  } else if (prompt.includes("PLATFORM_ERROR")) {
    process.stdout.write(JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true, session_id: "session-error" }) + "\n");
  } else if (prompt.includes("AUTH_REQUIRED")) {
    process.stdout.write(JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true, error: "Authentication required: run login" }) + "\n");
  } else if (prompt.includes("MALFORMED")) {
    process.stdout.write(`${output}\n`);
  } else {
    process.stdout.write(JSON.stringify({ type: "result", result: output }) + "\n");
  }
}
