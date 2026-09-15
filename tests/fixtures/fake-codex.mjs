#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes("--version")) {
  process.stdout.write("fake-codex 1.0.0\n");
  process.exit(0);
}
const prompt = args.at(-1) ?? "";
let output = "wrong";
if (prompt.includes("hello skill")) output = "hello skill";
else if (prompt.includes("compact JSON object")) output = "{\"ok\":true}";
else if (prompt.includes("preserve behavior")) output = "preserve behavior";
process.stdout.write(JSON.stringify({ type: "result", result: output }) + "\n");
