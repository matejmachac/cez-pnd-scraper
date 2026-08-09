import { DateTime } from "luxon";

export function nextDailyRun(nowMs, hour, minute, timezone = "Europe/Prague") {
  const now = DateTime.fromMillis(nowMs, { zone: timezone });
  let candidate = now.startOf("day").set({ hour, minute });
  if (candidate.toMillis() <= nowMs) candidate = candidate.plus({ days: 1 });
  return candidate.toMillis();
}

export function millisecondsUntilDailyWindow(nowMs, hour, minute, timezone = "Europe/Prague") {
  const now = DateTime.fromMillis(nowMs, { zone: timezone });
  const today = now.startOf("day").set({ hour, minute });
  return Math.max(0, today.toMillis() - nowMs);
}

export function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}
