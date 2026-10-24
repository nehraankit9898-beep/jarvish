import { describe, expect, test } from 'bun:test';
import { encodeChatEvent, readChatText, type ChatStreamEvent } from '../src/lib/chat-stream';

function response(events: ChatStreamEvent[], split = false) {
  return new Response(new ReadableStream<Uint8Array>({ start(controller) {
    for (const event of events) {
      const bytes = encodeChatEvent(event);
      if (split) for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
      else controller.enqueue(bytes);
    }
    controller.close();
  } }), { headers: { 'X-Chat-Stream': 'ndjson-v1' } });
}
const collect = async (res: Response) => {
  let text = '';
  for await (const chunk of readChatText(res)) text += chunk;
  return text;
};

describe('chat diagnostics are not assistant/TTS text', () => {
  test('fragmented Unicode frames and escaped newlines round-trip', async () => {
    expect(await collect(response([{ type: 'text', text: 'नमस्ते\nHello' }, { type: 'done' }], true))).toBe('नमस्ते\nHello');
  });

  test('exact structured error reaches the UI but is never yielded to TTS', async () => {
    const fed: string[] = [];
    let caught: unknown;
    try {
      for await (const chunk of readChatText(response([
        { type: 'text', text: 'Partial reply.' },
        { type: 'error', error: 'Provider overloaded', errorCategory: 'server', hint: 'Retry shortly.' },
      ], true))) fed.push(chunk);
    } catch (error) { caught = error; }
    expect(fed).toEqual(['Partial reply.']);
    expect((caught as Error).message).toBe('Provider overloaded');
    expect((caught as { chatFailure: unknown }).chatFailure).toEqual({ error: 'Provider overloaded', errorCategory: 'server', hint: 'Retry shortly.' });
  });

  test('EOF without an explicit done frame is a failure, not a successful partial reply', async () => {
    await expect(collect(response([{ type: 'text', text: 'partial' }]))).rejects.toThrow('interrupted');
  });

  test('legacy plain-text response stays compatible', async () => {
    expect(await collect(new Response('Hello'))).toBe('Hello');
  });

  test('a final done frame needs no trailing newline', async () => {
    const res = new Response('{"type":"text","text":"ok"}\n{"type":"done"}', { headers: { 'X-Chat-Stream': 'ndjson-v1' } });
    expect(await collect(res)).toBe('ok');
  });

  test('breaking iteration cancels the upstream reader', async () => {
    let cancelled = false;
    const res = new Response(new ReadableStream({
      start(c) { c.enqueue(encodeChatEvent({ type: 'text', text: 'hello' })); },
      cancel() { cancelled = true; },
    }), { headers: { 'X-Chat-Stream': 'ndjson-v1' } });
    for await (const _chunk of readChatText(res)) break;
    expect(cancelled).toBe(true);
  });

  test('unknown protocol events fail visibly', async () => {
    const res = new Response('{"type":"unexpected"}\n', { headers: { 'X-Chat-Stream': 'ndjson-v1' } });
    await expect(collect(res)).rejects.toThrow('Invalid chat stream event');
  });
});
