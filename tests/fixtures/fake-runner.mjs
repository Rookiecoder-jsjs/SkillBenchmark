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
if (prompt.includes("TIMEOUT")) {
  setTimeout(() => {}, 10_000);
} else {
  const output = prompt.includes("REAL_FAIL") ? "wrong" : "real ok";
  process.stdout.write(JSON.stringify({ type: "result", result: output }) + "\n");
}
