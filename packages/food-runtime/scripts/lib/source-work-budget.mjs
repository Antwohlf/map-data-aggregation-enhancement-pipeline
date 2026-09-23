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
