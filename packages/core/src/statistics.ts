import { randomUUID } from "node:crypto";
import type { ConditionId, ComparisonResult, GateDecision, GatePolicy, RunReport } from "../../contracts/src/types.ts";

export const defaultGatePolicy: GatePolicy = { min_iteration_gain: 0.03, min_iteration_ci_lower: 0, max_relative_none_loss: -0.02, max_missing_pair_rate: 0.05, max_key_regressions: 0 };

function quantile(values: number[], probability: number): number {
  if (!values.length) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * probability;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

function bootstrap(values: number[], samples = 1000, seed = 42): { lower: number; upper: number; level: number } {
  if (!values.length) return { lower: NaN, upper: NaN, level: 0.95 };
  let state = seed >>> 0;
  const random = () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) / 0x100000000; };
  const estimates: number[] = [];
  for (let sample = 0; sample < samples; sample += 1) {
    let total = 0;
    for (let index = 0; index < values.length; index += 1) total += values[Math.floor(random() * values.length)];
    estimates.push(total / values.length);
  }
  return { lower: quantile(estimates, 0.025), upper: quantile(estimates, 0.975), level: 0.95 };
}

export function compareConditions(report: RunReport, left: ConditionId, right: ConditionId, samples = 1000): ComparisonResult {
  const pairs = new Map<string, Map<ConditionId, number>>();
  for (const result of report.results) {
    const key = `${result.spec.task_id}|${result.spec.profile_id}|${result.spec.repeat_index}`;
    const pair = pairs.get(key) ?? new Map<ConditionId, number>();
    if (result.grade.outcome !== "ungradable") pair.set(result.spec.condition_id, result.grade.metrics.exact_match);
    pairs.set(key, pair);
  }
  const differences: number[] = [];
  const clusters = new Map<string, number[]>();
  const regressions: ComparisonResult["regressions"] = [];
  let missingPairs = 0;
  for (const [key, pair] of pairs) {
    if (!pair.has(left) || !pair.has(right)) { missingPairs += 1; continue; }
    const difference = (pair.get(right) as number) - (pair.get(left) as number);
    differences.push(difference);
    const [taskId, profileId] = key.split("|");
    const cluster = clusters.get(`${taskId}|${profileId}`) ?? [];
    cluster.push(difference);
    clusters.set(`${taskId}|${profileId}`, cluster);
    if (pair.get(left) === 1 && pair.get(right) === 0) {
      const [task_id, profile_id, repeat] = key.split("|");
      regressions.push({ task_id, profile_id, repeat_index: Number(repeat) });
    }
  }
  const clusterDifferences = [...clusters.values()].map((values) => values.reduce((a, b) => a + b, 0) / values.length);
  const interval = clusterDifferences.length ? bootstrap(clusterDifferences, samples, left.length * 100 + right.length) : null;
  return { schema_version: "0.1", run_id: report.run_id, left, right, strata: [...new Set(report.plan.profiles.map((profile) => profile.profile_id))], effect: clusterDifferences.length ? clusterDifferences.reduce((a, b) => a + b, 0) / clusterDifferences.length : null, interval, regressions, missingness: { missing_pairs: missingPairs, total_pairs: pairs.size } };
}

export function compareByProfile(report: RunReport, left: ConditionId, right: ConditionId, samples = 1000): ComparisonResult[] {
  return report.plan.profiles.map((profile) => {
    const scoped = { ...report, plan: { ...report.plan, profiles: [profile] }, results: report.results.filter((result) => result.spec.profile_id === profile.profile_id) };
    return { ...compareConditions(scoped, left, right, samples), profile_id: profile.profile_id };
  });
}

export function evaluateGate(report: RunReport, policy: GatePolicy = defaultGatePolicy): GateDecision {
  const comparisons = report.comparisons ?? [compareConditions(report, "none", "incumbent"), compareConditions(report, "incumbent", "candidate"), compareConditions(report, "none", "candidate")];
  const candidateIncumbent = comparisons.find((comparison) => comparison.left === "incumbent" && comparison.right === "candidate");
  const candidateNone = comparisons.find((comparison) => comparison.left === "none" && comparison.right === "candidate");
  const reasons: string[] = [];
  let status: GateDecision["status"] = "accept";
  if (!candidateIncumbent || !candidateNone) { status = "inconclusive"; reasons.push("required candidate comparisons are missing"); }
  else {
    const missingRate = candidateIncumbent.missingness.total_pairs ? candidateIncumbent.missingness.missing_pairs / candidateIncumbent.missingness.total_pairs : 1;
    if (missingRate > policy.max_missing_pair_rate) { status = "inconclusive"; reasons.push(`missing pair rate ${(missingRate * 100).toFixed(1)}% exceeds ${(policy.max_missing_pair_rate * 100).toFixed(1)}%`); }
    if (candidateIncumbent.effect === null || !candidateIncumbent.interval || candidateNone.effect === null || !candidateNone.interval || candidateIncumbent.missingness.total_pairs < 2) { status = "inconclusive"; reasons.push("too few comparable pairs for a stable interval"); }
    else {
      if (candidateIncumbent.effect < policy.min_iteration_gain || candidateIncumbent.interval.lower <= policy.min_iteration_ci_lower) { status = "reject"; reasons.push(`candidate gain ${candidateIncumbent.effect.toFixed(3)} with CI lower ${candidateIncumbent.interval.lower.toFixed(3)} does not meet policy`); }
      if (candidateNone.interval.lower < policy.max_relative_none_loss) { status = "reject"; reasons.push(`candidate relative-to-none CI lower ${candidateNone.interval.lower.toFixed(3)} is below ${policy.max_relative_none_loss.toFixed(3)}`); }
      if (candidateIncumbent.regressions.length > policy.max_key_regressions) { status = "reject"; reasons.push(`${candidateIncumbent.regressions.length} key regressions detected`); }
    }
  }
  if (!reasons.length) reasons.push("all configured gate checks passed");
  return { decision_id: `decision-${randomUUID()}`, comparison_refs: comparisons.map((comparison) => `${comparison.left}-${comparison.right}`), policy, status, reasons };
}

export function attachStatistics(report: RunReport, policy: GatePolicy = defaultGatePolicy): RunReport {
  const comparisons = [compareConditions(report, "none", "incumbent"), compareConditions(report, "incumbent", "candidate"), compareConditions(report, "none", "candidate"), ...compareByProfile(report, "incumbent", "candidate")];
  return { ...report, comparisons, gate: evaluateGate({ ...report, comparisons }, policy) };
}
