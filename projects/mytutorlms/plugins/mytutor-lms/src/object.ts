// Shared by the server and the admin bundle, so it imports nothing.
/** A copy of `value` without `keys`, for dropping fields before storing or returning. */
export function without<T extends object, K extends keyof T>(
  value: T,
  ...keys: K[]
): Omit<T, K> {
  const copy: Partial<T> = { ...value };
  for (const key of keys) delete copy[key];
  return copy as Omit<T, K>;
}
