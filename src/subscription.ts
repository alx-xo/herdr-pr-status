import type { Socket } from 'node:net';
import { StringDecoder } from 'node:string_decoder';

/** Bounded newline frames; keep parsing after the acknowledgement, including its chunk. */
export function subscribe(stream: Socket, event: (value: unknown) => void, failed: (error: Error) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    let buffer = '';
    let acknowledged = false;
    let ended = false;
    const decoder = new StringDecoder('utf8');
    const cleanup = () => {
      clearTimeout(timeout);
      stream.off('data', data); stream.off('error', fail); stream.off('close', closed);
      stream.off('connect', connect);
    };
    const fail = (error: Error) => {
      if (ended) return;
      ended = true; cleanup();
      if (!acknowledged) reject(error); else failed(error);
      stream.destroy();
    };
    const closed = () => fail(new Error('Herdr subscription closed'));
    const timeout = setTimeout(() => fail(new Error('Herdr subscription handshake timed out')), 5000);
    const data = (chunk: Buffer) => {
      // Process bounded fragments rather than retaining an arbitrarily large chunk.
      for (let offset = 0; offset < chunk.length && !ended; offset += 4096) {
        buffer += decoder.write(chunk.subarray(offset, offset + 4096));
        let end: number;
        while ((end = buffer.indexOf('\n')) >= 0 && !ended) {
          if (end > 65536) { fail(new Error('Oversized Herdr subscription frame')); return; }
          const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
          try {
            const value = JSON.parse(line);
            if (!acknowledged) {
              if (value.id !== 'pr-status-lifetime' || value.result?.type !== 'subscription_started') throw new Error('Herdr subscription rejected');
              acknowledged = true; clearTimeout(timeout); resolve();
            } else event(value);
          } catch (error) { fail(error instanceof Error ? error : new Error(String(error))); }
        }
        if (buffer.length > 65536) fail(new Error('Oversized Herdr subscription frame'));
      }
    };
    const connect = () => stream.write(JSON.stringify({
      id: 'pr-status-lifetime', method: 'events.subscribe',
      params: { subscriptions: [{ type: 'workspace.closed' }, { type: 'workspace.focused' }] },
    }) + '\n');
    stream.on('data', data); stream.once('error', fail); stream.once('close', closed);
    stream.once('connect', connect);
  });
}
