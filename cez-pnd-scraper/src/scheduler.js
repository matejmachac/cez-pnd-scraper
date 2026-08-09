export function nextAlignedRun(nowMs, intervalMinutes, offsetMinutes) {
  const intervalMs = intervalMinutes * 60_000;
  const offsetMs = offsetMinutes * 60_000;
  return Math.floor((nowMs - offsetMs) / intervalMs + 1) * intervalMs + offsetMs;
}

export function retryDelayMs(failureCount, intervalMinutes) {
  const maximum = intervalMinutes * 60_000;
  const exponential = 60_000 * 2 ** Math.max(0, failureCount - 1);
  return Math.min(exponential, maximum);
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
