let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { raw += chunk; });
process.stdin.on("end", () => {
  const input = JSON.parse(raw);
  const passed = input.artifact && input.artifact.output === input.task.expected_output;
  process.stdout.write(JSON.stringify({
    schema_version: "0.1",
    trial_id: input.trial_id,
    grader_digest: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    outcome: passed ? "pass" : "fail",
    metrics: { exact_match: passed ? 1 : 0 },
    assertions: [{ name: "external_exact_match", passed, detail: passed ? "ok" : "mismatch" }],
    evidence_refs: input.artifact ? [input.artifact.output_sha256] : []
  }));
});
