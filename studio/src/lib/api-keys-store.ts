'use client';

import { useCallback, useEffect, useState } from 'react';
import { getProvider, resolveModel, type ProviderId } from '@/lib/providers';

export interface ConnectionConfig {
  /**
   * Only set for a session-only/legacy key in tab memory. New keys
   * are stored ENCRYPTED on the server and the browser keeps `keyHint` only —
   * see settings-dialog.tsx.
   */
  apiKey: string;
  model: string;
  baseUrl: string;
  /** true ONLY after a real connection test succeeded for this configuration */
  connected: boolean;
  testedAt?: string;
  lastError?: string;
  /** last 4 characters of the server-stored key (never the key itself) */
  keyHint?: string;
  /** a key is stored server-side (encrypted) */
  serverStored?: boolean;
  /** the provider/model that produced `testedAt` (stale-test detection) */
  testedSign?: string;
}

export type ConnectionsMap = Partial<Record<ProviderId, ConnectionConfig>>;

const STORAGE_KEY = 'agentscope-studio-connections';
const ACTIVE_KEY = 'agentscope-studio-active-provider';
// Unsaved/legacy secrets may live in this tab, never in durable browser storage.
const sessionKeys = new Map<ProviderId, string>();
const keyIdentities = new Map<string, string>();

export function persistableConnections(map: ConnectionsMap): ConnectionsMap {
  return Object.fromEntries(Object.entries(map).map(([id, config]) => {
    if (!config) return [id, config];
    const hasSessionKey = Boolean(config.apiKey);
    return [id, {
      ...config,
      apiKey: '',
      // An old signature actually contained the entire raw API key.
      testedSign: hasSessionKey || config.testedSign?.includes('raw:') ? undefined : config.testedSign,
      connected: hasSessionKey ? false : config.connected,
    }];
  })) as ConnectionsMap;
}

/**
 * Substitutions made while loading stored settings. A retired model id is
 * rewritten to a supported one, but NEVER silently: the app shell drains this
 * queue and tells the user (toast + speech) which model changed and why.
 */
export interface ModelMigrationNotice {
  provider: ProviderId;
  from: string;
  to: string;
}

let pendingModelNotices: ModelMigrationNotice[] = [];

export function consumeModelNotices(): ModelMigrationNotice[] {
  const notices = pendingModelNotices;
  pendingModelNotices = [];
  return notices;
}

const DEFAULTS: Record<string, Partial<ConnectionConfig>> = {};

export function loadConnections(): ConnectionsMap {
  if (typeof window === 'undefined') return {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const map: ConnectionsMap = raw
      ? { ...DEFAULTS, ...(JSON.parse(raw) as ConnectionsMap) }
      : {};
    // Scrub legacy plaintext credentials (including old test signatures)
    // immediately, retaining the key in this tab until migration/save succeeds.
    const safe = persistableConnections(map);
    for (const id of Object.keys(map) as ProviderId[]) {
      const conn = map[id];
      if (!conn) continue;
      if (conn.apiKey) sessionKeys.set(id, conn.apiKey);
      conn.apiKey = sessionKeys.get(id) ?? '';
      if (conn.testedSign?.includes('raw:')) {
        conn.testedSign = undefined;
        conn.connected = false;
      }
    }
    if (raw && raw !== JSON.stringify(safe)) localStorage.setItem(STORAGE_KEY, JSON.stringify(safe));
    // Migration: purana retired model save hai (e.g. gemini-2.0-flash jo
    // Google ne shutdown kar diya) to load par hi current model par map karo —
    // taaki user ko dobara settings na bharni pade aur 404 na aaye.
    for (const id of Object.keys(map) as ProviderId[]) {
      const conn = map[id];
      if (conn?.model) {
        const resolved = resolveModel(getProvider(id), conn.model);
        if (resolved !== conn.model) {
          if (
            !pendingModelNotices.some((n) => n.provider === id && n.from === conn.model)
          ) {
            pendingModelNotices.push({ provider: id, from: conn.model, to: resolved });
          }
          conn.model = resolved;
        }
      }
    }
    return map;
  } catch {
    return {};
  }
}

export function saveConnections(map: ConnectionsMap) {
  if (typeof window === 'undefined') return;
  for (const id of Object.keys(map) as ProviderId[]) {
    if (map[id]?.apiKey) sessionKeys.set(id, map[id]!.apiKey);
    else sessionKeys.delete(id);
  }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(persistableConnections(map)));
  window.dispatchEvent(new Event('agentscope-connections-changed'));
}

/**
 * The configuration a connection test belongs to. Changing the model, the
 * base URL or the key invalidates an older "Connected" badge — a saved
 * configuration is NOT a verified connection.
 */
export function connectionSignature(config: {
  apiKey?: string;
  keyHint?: string;
  model?: string;
  baseUrl?: string;
}): string {
  // A key that lives on the server is identified by its hint (last 4 chars):
  // the browser never sees the secret, but an edit to the model/baseUrl still
  // invalidates an older "Connected" badge.
  const keyIdentity =
    config.apiKey && config.apiKey.length > 0
      ? (() => {
          let identity = keyIdentities.get(config.apiKey!);
          if (!identity) {
            identity = crypto.randomUUID();
            keyIdentities.set(config.apiKey!, identity);
          }
          return `session:${identity}`;
        })()
      : `hint:${config.keyHint ?? ''}`;
  return [keyIdentity, config.model ?? '', config.baseUrl ?? ''].join('|');
}

/** true when `connected` was earned for exactly this configuration. */
export function isVerified(config: ConnectionConfig | undefined): boolean {
  if (!config?.connected) return false;
  if (!config.testedSign) return false;
  return (
    config.testedSign ===
    connectionSignature({
      apiKey: config.apiKey ?? '',
      keyHint: config.keyHint,
      model: config.model ?? '',
      baseUrl: config.baseUrl ?? '',
    })
  );
}

export function loadActiveProvider(): ProviderId {
  if (typeof window === 'undefined') return 'zai';
  return (localStorage.getItem(ACTIVE_KEY) as ProviderId) || 'zai';
}

export function saveActiveProvider(id: ProviderId) {
  if (typeof window === 'undefined') return;
  localStorage.setItem(ACTIVE_KEY, id);
  window.dispatchEvent(new Event('agentscope-connections-changed'));
}

export function useConnections() {
  const [connections, setConnections] = useState<ConnectionsMap>({});
  const [activeProvider, setActiveProvider] = useState<ProviderId>('zai');
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    const refresh = () => {
      setConnections(loadConnections());
      setActiveProvider(loadActiveProvider());
      setLoaded(true);
    };
    refresh();
    // Best-effort migration: a failure keeps the key session-only, not on disk.
    // Settings can retry saving it; never overwrite a newer edit on completion.
    for (const [id, apiKey] of sessionKeys) {
      const config = loadConnections()[id];
      void (async () => {
        try {
          const res = await fetch(`/api/providers/${id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ apiKey, model: config?.model, baseUrl: config?.baseUrl }),
          });
          const data = await res.json();
          if (!res.ok || !data.hasKey) throw new Error('Encrypted key migration failed');
          const current = loadConnections();
          if (current[id]?.apiKey !== apiKey) return;
          current[id] = { ...current[id]!, apiKey: '', serverStored: true, keyHint: data.keyHint, connected: false, testedSign: undefined };
          saveConnections(current);
          refresh();
        } catch {
          const current = loadConnections();
          if (current[id]?.apiKey !== apiKey) return;
          current[id]!.lastError = 'Key is session-only: encrypted server save failed. Save it in Settings before closing this tab.';
          saveConnections(current);
          refresh();
        }
      })();
    }
    window.addEventListener('agentscope-connections-changed', refresh);
    window.addEventListener('storage', refresh);
    return () => {
      window.removeEventListener('agentscope-connections-changed', refresh);
      window.removeEventListener('storage', refresh);
    };
  }, []);

  const updateConnection = useCallback(
    (id: ProviderId, config: Partial<ConnectionConfig> | undefined) => {
      if (!config) return;
      const current = loadConnections();
      const next: ConnectionsMap = {
        ...current,
        [id]: {
          apiKey: '',
          model: '',
          baseUrl: '',
          connected: false,
          ...current[id],
          ...config,
        },
      };
      saveConnections(next);
      setConnections(next);
    },
    []
  );

  const removeConnection = useCallback((id: ProviderId) => {
    const current = loadConnections();
    delete current[id];
    sessionKeys.delete(id);
    saveConnections(current);
    setConnections(current);
    if (loadActiveProvider() === id) {
      saveActiveProvider('zai');
    }
  }, []);

  const switchProvider = useCallback((id: ProviderId) => {
    saveActiveProvider(id);
    setActiveProvider(id);
  }, []);

  return {
    connections,
    activeProvider,
    loaded,
    updateConnection,
    removeConnection,
    switchProvider,
  };
}
