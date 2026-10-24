'use client';

// Authenticated Server-Sent Events over fetch. Browser EventSource cannot set
// headers, which previously tempted the dashboard to put a build-time public
// token in every stream URL. fetch uses the same per-browser token as all
// other Studio API calls and supports precise cancellation/reconnects.

import { loadApiToken } from './api-token';

export interface EventStreamError {
  status?: number;
  error?: unknown;
}

export interface EventStreamClient {
  onopen: (() => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: EventStreamError) => void) | null;
  close: () => void;
}

export function openEventStream(url: string): EventStreamClient {
  const controller = new AbortController();
  const client: EventStreamClient = { onopen: null, onmessage: null, onerror: null, close: () => undefined };
  let closed = false;
  client.close = () => {
    if (closed) return;
    closed = true;
    controller.abort();
  };

  void (async () => {
    try {
      const token = loadApiToken();
      const headers = new Headers({ Accept: 'text/event-stream' });
      if (token) headers.set('x-agentscope-token', token);
      const response = await fetch(url, {
        headers,
        cache: 'no-store',
        signal: controller.signal,
      });
      if (!response.ok || !response.body) {
        if (!closed) client.onerror?.({ status: response.status });
        return;
      }
      if (closed) {
        await response.body.cancel().catch(() => undefined);
        return;
      }
      client.onopen?.();

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let eventName = '';
      let dataLines: string[] = [];
      const dispatch = () => {
        const data = dataLines.join('\n');
        dataLines = [];
        const name = eventName;
        eventName = '';
        // Match EventSource: named events (the server's `event: end`) do not
        // fire the default onmessage handler.
        if (data && (!name || name === 'message')) {
          client.onmessage?.({ data } as MessageEvent);
        }
      };

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        for (;;) {
          const newline = buffer.indexOf('\n');
          if (newline < 0) break;
          let line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (line.endsWith('\r')) line = line.slice(0, -1);
          if (!line) {
            dispatch();
            continue;
          }
          if (line.startsWith(':')) continue;
          const colon = line.indexOf(':');
          const field = colon < 0 ? line : line.slice(0, colon);
          let value = colon < 0 ? '' : line.slice(colon + 1);
          if (value.startsWith(' ')) value = value.slice(1);
          if (field === 'event') eventName = value;
          else if (field === 'data') dataLines.push(value);
        }
        if (closed) {
          await reader.cancel().catch(() => undefined);
          return;
        }
      }
      if (!closed) client.onerror?.({});
    } catch (error) {
      if (!closed) client.onerror?.({ error });
    }
  })();

  return client;
}
