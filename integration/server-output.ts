/** Drain server pipes with one lifetime byte budget; never retain or print raw
 * output, which may contain environment values or control bearer tokens. */
export function captureServerOutput(streams: ReadableStream<Uint8Array>[], maxBytes = 1024 * 1024) {
  const readers = streams.map(stream => stream.getReader());
  let bytes = 0;
  let error: Error | undefined;
  let stopped = false;
  let rejectFailure!: (error: Error) => void;
  const failure = new Promise<never>((_, reject) => { rejectFailure = reject; });
  // Overflow can precede the scenario's next await; always observe rejection.
  void failure.catch(() => {});
  const stop = () => {
    stopped = true;
    // Cancellation itself may wait on inherited pipes; do not await it.
    for (const reader of readers) void reader.cancel().catch(() => {});
  };
  const fail = (message: string) => {
    if (error) return;
    error = new Error(message);
    rejectFailure(error);
    stop();
  };
  const done = Promise.all(readers.map(async reader => {
    try {
      while (!stopped) {
        const { done, value } = await reader.read();
        if (done || stopped) break;
        if (value.byteLength > maxBytes - bytes) {
          fail(`Server output exceeded ${maxBytes} bytes`);
          break;
        }
        bytes += value.byteLength;
      }
    } catch { if (!stopped) fail('Server output read failed'); }
    finally { reader.releaseLock(); }
  }));
  const check = () => { if (error) throw error; };
  return {
    failure, check, stop,
    async finish(drainMs = 500): Promise<void> {
      const timer = setTimeout(() => fail('Server output drain timed out'), drainMs);
      try { await Promise.race([done, failure]); check(); }
      finally { clearTimeout(timer); stop(); }
    },
  };
}
