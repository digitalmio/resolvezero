/** Whether replacing `oldEntries` with `newEntries` fits the profile's budget. */
export function fitsBudget(
  resident: number,
  oldEntries: number,
  newEntries: number,
  cap: number,
): boolean {
  return Math.max(0, resident - oldEntries) + newEntries <= cap;
}
