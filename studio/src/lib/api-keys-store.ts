'use client';

import { useCallback, useEffect, useState } from 'react';
import { getProvider, resolveModel, type ProviderId } from '@/lib/providers';

export interface ConnectionConfig {
  apiKey: string;
  model: string;
  baseUrl: string;
  connected: boolean;
  testedAt?: string;
  lastError?: string;
}

export type ConnectionsMap = Partial<Record<ProviderId, ConnectionConfig>>;

const STORAGE_KEY = 'agentscope-studio-connections';
const ACTIVE_KEY = 'agentscope-studio-active-provider';

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
        if (resolved !== conn.model) conn.model = resolved;
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
