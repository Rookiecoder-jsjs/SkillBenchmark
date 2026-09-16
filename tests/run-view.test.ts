import test from "node:test";
import assert from "node:assert/strict";
import { buildRunDetailView, eventPresentation, formatDuration } from "../apps/web/src/run-view.ts";

test("run detail view derives honest timing, condition metrics and trial evidence", () => {
  const view = buildRunDetailView({
    runId: "run-1",
    status: "completed",
    createdAt: "2026-09-16T00:00:00.000Z",
    startedAt: "2026-09-16T00:00:01.000Z",
    finishedAt: "2026-09-16T00:00:05.000Z",
    events: [],
    report: {
      summary: {
        by_condition: { none: { total: 1, passed: 0, success_rate: 0 }, candidate: { total: 1, passed: 1, success_rate: 1 } },
        contrasts: [{ left: "none", right: "candidate", effect: 1, comparable_trials: 1 }],
      },
      results: [
        { spec: { trial_id: "trial-none", task_id: "task-1", condition_id: "none", repeat_index: 1 }, receipt: { status: "completed", started_at: "2026-09-16T00:00:01.000Z", finished_at: "2026-09-16T00:00:03.000Z", artifact: { output: "wrong", output_sha256: "abc" }, failure_reason: null }, grade: { outcome: "fail", metrics: { exact_match: 0 } }, events: [] },
        { spec: { trial_id: "trial-candidate", task_id: "task-1", condition_id: "candidate", repeat_index: 1 }, receipt: { status: "completed", started_at: "2026-09-16T00:00:02.000Z", finished_at: "2026-09-16T00:00:05.000Z", artifact: { output: "done", output_sha256: "def" }, failure_reason: null }, grade: { outcome: "pass", metrics: { exact_match: 1 } }, events: [] },
      ],
    },
  });

  assert.equal(view.wallTimeMs, 4_000);
  assert.equal(view.aggregateTrialTimeMs, 5_000, "parallel Trial time must remain separate from wall time");
  assert.equal(view.passedTrials, 1);
  assert.equal(view.totalTrials, 2);
  assert.equal(view.conditions[1]?.successRate, 1);
  assert.equal(view.contrasts[0]?.effect, 1);
  assert.equal(view.trials[0]?.repeatIndex, 1);
  assert.deepEqual(view.trials.map((trial) => [trial.condition, trial.durationMs, trial.output]), [["none", 2_000, "wrong"], ["candidate", 3_000, "done"]]);
});

test("event presentation recognizes platform tool events without inventing unavailable details", () => {
  const tool = eventPresentation({ kind: "platform.item.started", producer: "platform", data: { raw: JSON.stringify({ type: "item.started", item: { type: "command_execution", command: "npm test" } }) } });
  assert.equal(tool.category, "tool");
  assert.equal(tool.label, "command_execution");
  assert.equal(tool.detail, "npm test");

  const unknown = eventPresentation({ kind: "platform.event", producer: "platform", data: {} });
  assert.equal(unknown.category, "platform");
  assert.equal(unknown.detail, null);
  assert.equal(formatDuration(null), "unknown");
  assert.equal(formatDuration(65_432), "1m 5.4s");
});
