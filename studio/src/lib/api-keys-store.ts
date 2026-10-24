'use client';

import { useCallback, useEffect, useState } from 'react';
import { getProvider, resolveModel, type ProviderId } from '@/lib/providers';

export interface ConnectionConfig {
  /**
   * Only set when a key still lives in this browser (legacy value). New keys
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
  localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
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
    config.apiKey && config.apiKey.length > 0 ? `raw:${config.apiKey}` : `hint:${config.keyHint ?? ''}`;
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
