/** Chat transport: diagnostic events must never be fed to incremental TTS. */
export type ChatStreamEvent =
  | { type: 'text'; text: string }
  | { type: 'error'; error: string; errorCategory?: string; hint?: string }
  | { type: 'done' };

export function encodeChatEvent(event: ChatStreamEvent): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(event) + '\n');
}

/** Supports old plain-text servers too; v1 requires an explicit done event. */
export async function* readChatText(response: Response): AsyncGenerator<string> {
  if (!response.body) throw new Error('The chat server returned no response body.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const framed = response.headers.get('X-Chat-Stream') === 'ndjson-v1';
  let buffer = '';
  let completed = false;
  const parse = (line: string): string | null => {
    const event = JSON.parse(line) as ChatStreamEvent;
    if (event.type === 'error') {
      const error = new Error(event.error) as Error & { chatFailure: { error: string; errorCategory?: string; hint?: string } };
      error.chatFailure = { error: event.error, errorCategory: event.errorCategory, hint: event.hint };
      throw error;
    }
    if (event.type === 'done') { completed = true; return null; }
    if (event.type === 'text' && typeof event.text === 'string') return event.text;
    throw new Error('Invalid chat stream event.');
  };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      const chunk = done ? decoder.decode() : decoder.decode(value, { stream: true });
      if (!framed) {
        if (chunk) yield chunk;
        if (done) { completed = true; return; }
        continue;
      }
      buffer += chunk;
      if (buffer.length > 2_000_000) throw new Error('Chat stream event exceeded the size limit.');
      const lines = buffer.split('\n');
      buffer = done ? '' : lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        const text = parse(line);
        if (text) yield text;
        if (completed) return;
      }
      if (done) throw new Error('Chat stream interrupted before completion.');
    }
  } finally {
    // Also runs when the consumer stops iterating (Stop/navigation/error).
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
