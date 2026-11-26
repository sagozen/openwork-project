import type { Db } from "./db";
import { HttpError } from "./http";

export async function takeRateLimit(
  db: Db,
  bucket: string,
  limit: number,
  windowSeconds: number,
  message?: (retryAfterSeconds: number) => string,
  cost = 1,
): Promise<void> {
  const windowStart = Math.floor(Date.now() / 1000 / windowSeconds) * windowSeconds;
  await db.run("INSERT OR IGNORE INTO rate_limits (bucket, window_start, count) VALUES (?, ?, 0)", [
    bucket,
    windowStart,
  ]);
  const result = await db.run(
    "UPDATE rate_limits SET count = count + ? WHERE bucket = ? AND window_start = ? AND count + ? <= ?",
    [cost, bucket, windowStart, cost, limit],
  );
  if (result.changes === 0) {
    const retry = windowStart + windowSeconds - Math.floor(Date.now() / 1000);
    throw new HttpError(
      "rate_limited",
      429,
      message ? message(Math.max(1, retry)) : "Too many requests. Try again shortly.",
      { limit, windowSeconds },
      {
        "retry-after": String(Math.max(1, retry)),
      },
    );
  }
}
