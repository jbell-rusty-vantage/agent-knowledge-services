/** Deterministic lab statistics. Human-label provenance and dataset partitions are enforced by the experiment layer. */
export const VERIFICATION_STATISTICS_VERSION = "verification-statistics.v1";
const Z95 = 1.959963984540054;
const boundedCount = (value: number, maximum = 10_000) => Number.isSafeInteger(value) && value >= 0 && value <= maximum;
const probability = (value: number) => Number.isFinite(value) && value >= 0 && value <= 1;
export function wilson95(
  successes: number,
  total: number,
): { estimate: number | null; lower: number | null; upper: number | null; total: number } {
  if (!boundedCount(total, 1_000_000) || !boundedCount(successes, total)) throw new Error("STATISTICS_INVALID_COUNTS");
  if (!total) return { estimate: null, lower: null, upper: null, total };
  const estimate = successes / total,
    z2 = Z95 * Z95,
    denominator = 1 + z2 / total;
  const center = (estimate + z2 / (2 * total)) / denominator;
  const radius = (Z95 * Math.sqrt((estimate * (1 - estimate)) / total + z2 / (4 * total * total))) / denominator;
  return {
    estimate,
    lower: successes === 0 ? 0 : Math.max(0, center - radius),
    upper: successes === total ? 1 : Math.min(1, center + radius),
    total,
  };
}

/** Exact two-sided binomial McNemar test. Independent paired units are assumed; cluster bootstrap is separate. */
export function mcnemarExact(baselineOnlyCorrect: number, candidateOnlyCorrect: number) {
  if (
    !boundedCount(baselineOnlyCorrect) ||
    !boundedCount(candidateOnlyCorrect) ||
    baselineOnlyCorrect + candidateOnlyCorrect > 10_000
  )
    throw new Error("STATISTICS_INVALID_COUNTS");
  const n = baselineOnlyCorrect + candidateOnlyCorrect;
  if (!n) return { discordantPairs: 0, pValue: 1, logPValue: 0, numericalUnderflow: false };
  const k = Math.min(baselineOnlyCorrect, candidateOnlyCorrect);
  let term = -n * Math.LN2,
    sum = term;
  for (let index = 1; index <= k; index++) {
    term += Math.log(n - index + 1) - Math.log(index);
    const high = Math.max(sum, term);
    sum = high + Math.log(Math.exp(sum - high) + Math.exp(term - high));
  }
  const logPValue = Math.min(0, Math.LN2 + sum),
    pValue = Math.exp(logPValue);
  return { discordantPairs: n, pValue, logPValue, numericalUnderflow: pValue === 0 };
}

export interface PairedVerificationScore {
  readonly caseId: string;
  readonly clusterId: string;
  readonly baseline: number;
  readonly candidate: number;
}
const random32 = (seed: number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
};
const quantile = (sorted: readonly number[], p: number) => {
  const at = (sorted.length - 1) * p,
    low = Math.floor(at),
    fraction = at - low;
  return sorted[low]! * (1 - fraction) + sorted[Math.ceil(at)]! * fraction;
};

/** Resample whole report/source clusters; preserve every baseline/candidate pair within each sampled cluster. */
export function pairedClusterBootstrap(
  rows: readonly PairedVerificationScore[],
  options: { readonly seed: number; readonly resamples?: number },
) {
  const resamples = options.resamples ?? 2000;
  if (
    !rows.length ||
    rows.length > 10_000 ||
    !boundedCount(options.seed, 0xffffffff) ||
    !Number.isSafeInteger(resamples) ||
    resamples < 100 ||
    resamples > 10_000
  )
    throw new Error("STATISTICS_INVALID_BOOTSTRAP_INPUT");
  const ids = new Set<string>(),
    clusters = new Map<string, { sum: number; count: number }>();
  for (const row of [...rows].sort((a, b) => (a.caseId < b.caseId ? -1 : a.caseId > b.caseId ? 1 : 0))) {
    if (
      !row.caseId ||
      row.caseId.length > 255 ||
      ids.has(row.caseId) ||
      !row.clusterId ||
      row.clusterId.length > 255 ||
      !probability(row.baseline) ||
      !probability(row.candidate)
    )
      throw new Error("STATISTICS_INVALID_PAIRED_ROW");
    ids.add(row.caseId);
    const cluster = clusters.get(row.clusterId) ?? { sum: 0, count: 0 };
    cluster.sum += row.candidate - row.baseline;
    cluster.count++;
    clusters.set(row.clusterId, cluster);
  }
  const units = [...clusters.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, value]) => value);
  const estimate = units.reduce((sum, item) => sum + item.sum, 0) / rows.length;
  if (units.length < 2)
    return {
      estimate,
      lower: null,
      upper: null,
      clusters: units.length,
      cases: rows.length,
      resamples: 0,
      seed: options.seed,
      limitation: "insufficient_independent_clusters" as const,
    };
  if (units.length * resamples > 5_000_000) throw new Error("STATISTICS_RESAMPLING_WORK_LIMIT");
  const random = random32(options.seed),
    samples: number[] = [];
  for (let iteration = 0; iteration < resamples; iteration++) {
    let sum = 0,
      count = 0;
    for (let unit = 0; unit < units.length; unit++) {
      const chosen = units[Math.floor(random() * units.length)]!;
      sum += chosen.sum;
      count += chosen.count;
    }
    samples.push(sum / count);
  }
  samples.sort((a, b) => a - b);
  return {
    estimate,
    lower: quantile(samples, 0.025),
    upper: quantile(samples, 0.975),
    clusters: units.length,
    cases: rows.length,
    resamples,
    seed: options.seed,
    limitation: null,
  };
}

/**
 * Paired randomization test for a continuous mean difference under the null that
 * each cluster difference is sign-exchangeable. Up to 16 cluster units are
 * enumerated exactly; larger samples use deterministic Monte Carlo draws with
 * the standard +1 numerator/denominator correction.
 */
export function pairedSignFlipTest(
  differences: readonly number[],
  options: { readonly seed: number; readonly permutations?: number },
) {
  const permutations = options.permutations ?? 10_000;
  if (
    !differences.length ||
    differences.length > 10_000 ||
    differences.some((value) => !Number.isFinite(value) || Math.abs(value) > 1_000_000) ||
    !boundedCount(options.seed, 0xffffffff) ||
    !Number.isSafeInteger(permutations) ||
    permutations < 100 ||
    permutations > 100_000 ||
    differences.length * permutations > 5_000_000
  )
    throw new Error("STATISTICS_INVALID_SIGN_FLIP_INPUT");
  const observed = differences.reduce((sum, value) => sum + value, 0) / differences.length;
  if (differences.every((value) => value === 0))
    return {
      estimate: 0,
      pValue: 1,
      permutations: 0,
      seed: options.seed,
      extreme: 0,
      method: "degenerate" as const,
      nullHypothesis: "cluster_differences_are_sign_exchangeable" as const,
      monteCarloCorrection: null,
    };
  // Scaling before summation makes the comparison invariant to a common finite
  // multiplier and avoids an absolute epsilon that overwhelms tiny effects.
  const scale = Math.max(...differences.map(Math.abs));
  const normalized = differences.map((value) => value / scale);
  const observedMagnitude = Math.abs(normalized.reduce((sum, value) => sum + value, 0));
  // Both observed and permuted sums accumulate the same normalized magnitudes.
  // Include mathematical ties within a conservative forward-error bound in
  // normalized units; this is relative to the data and independent of scale.
  const comparisonTolerance =
    normalized.reduce((sum, value) => sum + Math.abs(value), 0) * differences.length * Number.EPSILON * 4;
  let extreme = 0;
  if (differences.length <= 16) {
    const assignments = 2 ** differences.length;
    for (let mask = 0; mask < assignments; mask++) {
      let sum = 0;
      for (let index = 0; index < normalized.length; index++)
        sum += (mask & (2 ** index)) === 0 ? normalized[index]! : -normalized[index]!;
      if (Math.abs(sum) + comparisonTolerance >= observedMagnitude) extreme++;
    }
    return {
      estimate: observed,
      pValue: extreme / assignments,
      permutations: assignments,
      seed: options.seed,
      extreme,
      method: "exact_enumeration" as const,
      nullHypothesis: "cluster_differences_are_sign_exchangeable" as const,
      monteCarloCorrection: null,
    };
  }
  const random = random32(options.seed);
  for (let iteration = 0; iteration < permutations; iteration++) {
    let sum = 0;
    for (const value of normalized) sum += random() < 0.5 ? value : -value;
    if (Math.abs(sum) + comparisonTolerance >= observedMagnitude) extreme++;
  }
  return {
    estimate: observed,
    pValue: (extreme + 1) / (permutations + 1),
    permutations,
    seed: options.seed,
    extreme,
    method: "monte_carlo" as const,
    nullHypothesis: "cluster_differences_are_sign_exchangeable" as const,
    monteCarloCorrection: "plus_one" as const,
  };
}

export interface CalibrationObservation {
  readonly probability: number;
  readonly correct: boolean;
}
export function verificationCalibration(observations: readonly CalibrationObservation[], binCount = 10) {
  if (
    observations.length > 100_000 ||
    !Number.isInteger(binCount) ||
    binCount < 1 ||
    binCount > 100 ||
    observations.some((item) => !probability(item.probability) || typeof item.correct !== "boolean")
  )
    throw new Error("STATISTICS_INVALID_CALIBRATION_INPUT");
  const buckets = Array.from({ length: binCount }, (_, index) => ({
    lower: index / binCount,
    upper: (index + 1) / binCount,
    count: 0,
    probabilitySum: 0,
    correctSum: 0,
  }));
  let brierSum = 0;
  for (const item of observations) {
    const bucket = buckets[Math.min(binCount - 1, Math.floor(item.probability * binCount))]!;
    bucket.count++;
    bucket.probabilitySum += item.probability;
    bucket.correctSum += Number(item.correct);
    brierSum += (item.probability - Number(item.correct)) ** 2;
  }
  const bins = buckets.map(({ lower, upper, count, probabilitySum, correctSum }) => ({
    lower,
    upper,
    count,
    meanProbability: count ? probabilitySum / count : null,
    accuracy: count ? correctSum / count : null,
  }));
  const ece = observations.length
    ? bins.reduce(
        (sum, bin) =>
          sum + (bin.count / observations.length) * Math.abs((bin.accuracy ?? 0) - (bin.meanProbability ?? 0)),
        0,
      )
    : null;
  return { count: observations.length, brier: observations.length ? brierSum / observations.length : null, ece, bins };
}

/** Tied confidence values are admitted together; thresholds are not selected here. */
export function verificationRiskCoverage(observations: readonly CalibrationObservation[]) {
  if (
    observations.length > 100_000 ||
    observations.some((item) => !probability(item.probability) || typeof item.correct !== "boolean")
  )
    throw new Error("STATISTICS_INVALID_RISK_INPUT");
  const ordered = [...observations].sort((a, b) => b.probability - a.probability);
  const curve: { threshold: number | null; accepted: number; coverage: number; risk: number | null }[] = [
    { threshold: null, accepted: 0, coverage: 0, risk: null },
  ];
  let accepted = 0,
    errors = 0;
  while (accepted < ordered.length) {
    const threshold = ordered[accepted]!.probability;
    do {
      errors += Number(!ordered[accepted]!.correct);
      accepted++;
    } while (accepted < ordered.length && ordered[accepted]!.probability === threshold);
    curve.push({ threshold, accepted, coverage: accepted / ordered.length, risk: errors / accepted });
  }
  return curve;
}

/** Holm step-down family-wise adjustment; IDs preserve the declared hypothesis family. */
export function holmAdjustment(tests: readonly { readonly id: string; readonly pValue: number }[]) {
  if (
    tests.length > 10_000 ||
    new Set(tests.map((item) => item.id)).size !== tests.length ||
    tests.some((item) => !item.id || item.id.length > 255 || !probability(item.pValue))
  )
    throw new Error("STATISTICS_INVALID_HYPOTHESIS_FAMILY");
  const ordered = [...tests].sort((a, b) => a.pValue - b.pValue || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  let prior = 0;
  return ordered.map((item, index) => {
    prior = Math.min(1, Math.max(prior, item.pValue * (tests.length - index)));
    return { ...item, adjustedPValue: prior };
  });
}
