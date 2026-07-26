export async function runQualityLoop({
  initialCandidate,
  validate,
  develop,
  isPassing = (result) => Boolean(result?.passed),
  scoreOf = (result) => Number(result?.score || 0),
  maxIterations = 10,
  stagnationLimit = 2,
  minimumImprovement = 0.0005
}) {
  if (typeof validate !== "function") throw new Error("validate must be a function.");
  if (typeof develop !== "function") throw new Error("develop must be a function.");
  const hardLimit = Math.max(1, Math.min(10, Math.floor(maxIterations)));
  const history = [];
  let candidate = initialCandidate;
  let bestCandidate = initialCandidate;
  let bestResult = null;
  let bestScore = -Infinity;
  let stagnant = 0;
  let stopReason = "iteration-limit";

  for (let iteration = 1; iteration <= hardLimit; iteration += 1) {
    const result = await validate(candidate, { iteration, history: [...history] });
    const score = scoreOf(result);
    const improved = score > bestScore + minimumImprovement;
    if (improved || bestResult === null) {
      bestScore = score;
      bestResult = result;
      bestCandidate = candidate;
      stagnant = 0;
    } else {
      stagnant += 1;
    }
    history.push({
      iteration,
      score,
      passed: isPassing(result),
      improved,
      diagnostics: result?.diagnostics || [],
      result
    });
    if (isPassing(result)) {
      stopReason = "quality-gates-passed";
      break;
    }
    if (stagnant >= stagnationLimit) {
      stopReason = "stagnated";
      break;
    }
    if (iteration === hardLimit) break;
    candidate = await develop({
      candidate: bestCandidate,
      result,
      bestResult,
      iteration,
      history: [...history]
    });
  }

  return {
    bestCandidate,
    bestResult,
    bestScore,
    history,
    iterations: history.length,
    stopReason,
    passed: Boolean(bestResult && isPassing(bestResult))
  };
}
