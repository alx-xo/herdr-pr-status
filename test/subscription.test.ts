import { expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import type { Socket } from 'node:net';
import { subscribe } from '../src/subscription';

function fixture() {
  const stream = Object.assign(new EventEmitter(), {
    request: '', destroyed: false,
    write(value: string) { this.request += value; },
    destroy() { this.destroyed = true; stream.emit('close'); },
  });
  const events: unknown[] = []; const failures: Error[] = [];
  // Only the Socket methods exercised by subscribe are needed for deterministic framing tests.
  const ready = subscribe(stream as unknown as Socket, value => events.push(value), error => failures.push(error));
  stream.emit('connect');
  const ack = JSON.stringify({ id: JSON.parse(stream.request).id, result: { type: 'subscription_started' } }) + '\n';
  return { stream, events, failures, ready, ack, send: (value: string | Buffer) => stream.emit('data', Buffer.from(value)) };
}
const focus = JSON.stringify({ event: 'workspace_focused', data: { type: 'workspace_focused', workspace_id: 'w-é' } }) + '\n';

test('ack and events in one chunk stay subscribed; fragmented UTF-8 and lines are retained', async () => {
  const f = fixture();
  f.send(f.ack.slice(0, 5)); f.send(f.ack.slice(5) + focus);
  await f.ready;
  const bytes = Buffer.from(focus);
  for (const byte of bytes) f.send(Buffer.from([byte]));
  expect(f.events).toEqual([JSON.parse(focus), JSON.parse(focus)]);
  expect(JSON.parse(f.stream.request).params.subscriptions).toContainEqual({ type: 'workspace.focused' });
  f.stream.destroy(); f.send(focus);
  expect(f.events).toHaveLength(2);
  expect(f.failures).toHaveLength(1);
  expect(f.stream.listenerCount('close')).toBe(0);
});
test('bounds each frame, not the combined size of legitimate events', async () => {
  const f = fixture(); f.send(f.ack + focus.repeat(1000)); await f.ready;
  expect(f.events).toHaveLength(1000);
  f.send('x'.repeat(65537));
  f.send(focus); f.stream.emit('close');
  expect(f.failures).toHaveLength(1); expect(f.events).toHaveLength(1000);
  expect(f.failures[0]?.message).toContain('Oversized');
  expect(f.stream.destroyed).toBe(true);
});
test('rejection and premature close reject handshake and clean listeners', async () => {
  const f = fixture(); f.send('{"error":{"message":"unsupported"}}\n');
  await expect(f.ready).rejects.toThrow('Herdr subscription rejected');
  const g = fixture(); g.stream.destroy();
  await expect(g.ready).rejects.toThrow('closed');
});
test('malformed event after acknowledgement fails once and cleans up', async () => {
  const f = fixture(); f.send(f.ack + '{bad}\n' + focus); await f.ready;
  f.send(focus); f.stream.emit('close');
  expect(f.failures).toHaveLength(1); expect(f.events).toHaveLength(0);
});
