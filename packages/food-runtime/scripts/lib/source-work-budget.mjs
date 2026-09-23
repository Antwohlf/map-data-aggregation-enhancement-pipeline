// Charge one unit after one regional source page completes its review path.
// Keeping this tiny helper shared by the scheduler and its tests makes the
// configured cap explicit and prevents a completed page being charged twice.
export function nextSourceWorkUnitCount(current, maximum) {
  if (!Number.isSafeInteger(current) || current < 0 || !Number.isSafeInteger(maximum) || maximum < 1) {
    throw new TypeError('Invalid source work-unit budget');
  }
  if (current >= maximum) throw new RangeError('Source work-unit budget exceeded');
  return current + 1;
}

export function sourceRegionIndexForRun(index, consecutiveFailures, failureRotationThreshold, regionCount) {
  if (!Number.isSafeInteger(index) || index < 0 || !Number.isSafeInteger(consecutiveFailures) || consecutiveFailures < 0
    || !Number.isSafeInteger(failureRotationThreshold) || failureRotationThreshold < 0
    || !Number.isSafeInteger(regionCount) || regionCount < 1) {
    throw new TypeError('Invalid source region rotation state');
  }
  if (regionCount > 1 && failureRotationThreshold > 0 && consecutiveFailures >= failureRotationThreshold) {
    return (index + 1) % regionCount;
  }
  return index % regionCount;
}

export function selectSourceRegionIndex(index, consecutiveFailures, failureRotationThreshold, backlogByIndex = [], failureRotationPending = false) {
  const rotatedIndex = sourceRegionIndexForRun(
    index,
    consecutiveFailures,
    failureRotationThreshold,
    backlogByIndex.length,
  );
  const rotationPending = failureRotationPending || (backlogByIndex.length > 1
    && failureRotationThreshold > 0
    && consecutiveFailures >= failureRotationThreshold);
  if (rotationPending) return rotatedIndex;

  const scored = backlogByIndex
    .map((backlog, regionIndex) => ({ backlog, regionIndex }))
    .filter(item => item.backlog !== null && item.backlog > 0);
  if (!scored.length) return rotatedIndex;
  return scored.sort((left, right) => right.backlog - left.backlog || left.regionIndex - right.regionIndex)[0].regionIndex;
}

export function advanceSourceRegionIndex(startIndex, completedPages, regionCount) {
  if (!Number.isSafeInteger(startIndex) || startIndex < 0 || !Number.isSafeInteger(completedPages) || completedPages < 1
    || !Number.isSafeInteger(regionCount) || regionCount < 1) {
    throw new TypeError('Invalid source region cursor state');
  }
  return (startIndex + completedPages) % regionCount;
}
