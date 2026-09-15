#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes("--version")) {
  process.stdout.write("fake-claude 1.0.0\n");
  process.exit(0);
}
const promptIndex = args.indexOf("-p");
const prompt = promptIndex >= 0 ? args[promptIndex + 1] : "";
const output = prompt.includes("native smoke") ? "native ok" : "wrong";
process.stdout.write(JSON.stringify({ type: "result", result: output }) + "\n");
