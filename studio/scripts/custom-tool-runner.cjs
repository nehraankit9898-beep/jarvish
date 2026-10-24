'use strict';

// Isolated custom-tool process. The parent starts this file with Node's
// permission model enabled, a sanitized environment, no shell, no fs-write /
// child-process / worker permissions, and a bounded heap. IPC is the only
// bridge back to Studio; every fetch request is re-validated by the parent.

const vm = require('node:vm');

const MAX_IPC_CHARS = 256 * 1024;
const timers = new Set();
const pendingFetches = new Map();
let fetchSeq = 0;
let running = false;

function send(message) {
  if (!process.connected) return false;
  let encoded;
  try {
    encoded = JSON.stringify(message);
  } catch {
    return false;
  }
  if (encoded.length > MAX_IPC_CHARS) return false;
  try {
    process.send(message);
    return true;
  } catch {
    return false;
  }
}

function clearTimers() {
  for (const timer of timers) {
    clearTimeout(timer);
    clearInterval(timer);
  }
  timers.clear();
}

function clamp(value, min, max) {
  const number = Number(value);
  return Math.min(Math.max(min, Number.isFinite(number) ? number : min), max);
}

function makeApi() {
  return {
    fetch(url, init = {}) {
      const id = ++fetchSeq;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pendingFetches.delete(id);
          reject(new Error('Custom tool fetch bridge timed out'));
        }, 35_000);
        pendingFetches.set(id, { resolve, reject, timer });
        if (!send({ type: 'fetch', id, url: String(url ?? ''), init })) {
          clearTimeout(timer);
          pendingFetches.delete(id);
          reject(new Error('Custom tool fetch bridge is unavailable'));
        }
      });
    },
    log(line) {
      send({ type: 'log', line: String(line ?? '').slice(0, 500) });
    },
    now: () => Date.now(),
  };
}

function makeSandbox(params) {
  const sandbox = {
    params,
    api: makeApi(),
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    AbortController,
    AbortSignal,
  };
  sandbox.setTimeout = (fn, ms = 0, ...args) => {
    const id = setTimeout(() => {
      timers.delete(id);
      if (typeof fn === 'function') fn(...args);
    }, clamp(ms, 0, 30_000));
    timers.add(id);
    return id;
  };
  sandbox.clearTimeout = (id) => {
    clearTimeout(id);
    timers.delete(id);
  };
  sandbox.setInterval = (fn, ms = 1000, ...args) => {
    const id = setInterval(() => {
      if (typeof fn === 'function') fn(...args);
    }, clamp(ms, 1000, 60_000));
    timers.add(id);
    return id;
  };
  sandbox.clearInterval = (id) => {
    clearInterval(id);
    timers.delete(id);
  };
  return sandbox;
}

async function execute(message) {
  const timeoutMs = clamp(message.timeoutMs, 1, 30_000);
  const context = vm.createContext(makeSandbox(message.params ?? {}), {
    codeGeneration: { strings: false, wasm: false },
  });
  const script = new vm.Script(`"use strict";\n(async () => {\n${message.code}\n})()`, {
    filename: 'custom-tool.js',
  });
  const value = script.runInContext(context, { timeout: timeoutMs, breakOnSigint: false });
  const result = await Promise.resolve(value);
  // IPC uses JSON serialization. Check the result here so cyclic or very large
  // values fail honestly instead of crashing the parent or exhausting memory.
  const encoded = JSON.stringify(result === undefined ? null : result);
  if (encoded !== undefined && encoded.length > MAX_IPC_CHARS) {
    throw new Error('Custom tool result exceeds the 256 KB limit');
  }
  return result;
}

process.on('message', (message) => {
  if (!message || typeof message !== 'object') return;
  if (message.type === 'fetch_result') {
    const pending = pendingFetches.get(message.id);
    if (!pending) return;
    pendingFetches.delete(message.id);
    clearTimeout(pending.timer);
    if (message.ok) pending.resolve(message.result);
    else pending.reject(new Error(String(message.error || 'Custom tool fetch failed').slice(0, 500)));
    return;
  }
  if (message.type !== 'run' || running) return;
  running = true;
  void execute(message).then(
    (result) => {
      clearTimers();
      send({ type: 'result', ok: true, result: result === undefined ? null : result });
      process.exit(0);
    },
    (error) => {
      clearTimers();
      const text = error && typeof error.message === 'string' ? error.message : String(error || 'Tool execution failed');
      send({ type: 'result', ok: false, error: text.slice(0, 1000) });
      process.exit(0);
    }
  );
});

process.on('disconnect', () => {
  clearTimers();
  process.exit(0);
});
