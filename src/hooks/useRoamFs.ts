import { useState, useCallback, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { Invokes } from '../components/ui/AppProperties';
import { useUIStore, type RemoteConnection } from '../store/useUIStore';

export interface RemoteConnectionStatus extends RemoteConnection {
  isMounted: boolean;
  localPath: string | null;
  dirtyCount: number;
  conflictCount: number;
  totalCachedMib: number;
}

export function useRoamFs() {
  const [connections, setConnections] = useState<RemoteConnectionStatus[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const setUI = useUIStore((state) => state.setUI);

  const refreshConnections = useCallback(async () => {
    setIsLoading(true);
    try {
      const conns: RemoteConnection[] = await invoke(Invokes.RoamfsListConnections);
      const statuses = await Promise.all(
        conns.map(async (conn) => {
          try {
            const status: Omit<RemoteConnectionStatus, keyof RemoteConnection> = await invoke(
              Invokes.RoamfsStatus,
              { id: conn.id },
            );
            return { ...conn, ...status };
          } catch {
            return {
              ...conn,
              isMounted: false,
              localPath: null,
              dirtyCount: 0,
              conflictCount: 0,
              totalCachedMib: 0,
            };
          }
        }),
      );
      setConnections(statuses);
    } catch (err) {
      console.error('Failed to list roamfs connections:', err);
    } finally {
      setIsLoading(false);
    }
  }, []);

  const addConnection = useCallback(
    async (conn: RemoteConnection) => {
      await invoke(Invokes.RoamfsAddConnection, { conn });
      await refreshConnections();
    },
    [refreshConnections],
  );

  const removeConnection = useCallback(
    async (id: string) => {
      await invoke(Invokes.RoamfsRemoveConnection, { id });
      await refreshConnections();
    },
    [refreshConnections],
  );

  const mountConnection = useCallback(
    async (id: string) => {
      const path: string = await invoke(Invokes.RoamfsMount, { id });
      await refreshConnections();
      return path;
    },
    [refreshConnections],
  );

  const unmountConnection = useCallback(
    async (id: string) => {
      await invoke(Invokes.RoamfsUnmount, { id });
      await refreshConnections();
    },
    [refreshConnections],
  );

  const syncConnection = useCallback(
    async (id: string) => {
      const result: { pushed: string[]; conflicts: string[] } = await invoke(
        Invokes.RoamfsSyncNow,
        { id },
      );
      await refreshConnections();
      return result;
    },
    [refreshConnections],
  );

  useEffect(() => {
    refreshConnections();

    const unmounteds: (() => void)[] = [];

    listen('roamfs-mounted', (event: any) => {
      console.log('RoamFS mounted:', event.payload);
      refreshConnections();
    }).then((unlisten) => unmounteds.push(unlisten));

    listen('roamfs-conflicts-detected', (event: any) => {
      const { connectionId, conflicts } = event.payload;
      if (conflicts?.length > 0) {
        setUI({
          conflictResolutionModalState: {
            isOpen: true,
            connectionId,
            conflicts,
          },
        });
      }
    }).then((unlisten) => unmounteds.push(unlisten));

    return () => {
      unmounteds.forEach((u) => u());
    };
  }, [refreshConnections, setUI]);

  return {
    connections,
    isLoading,
    refreshConnections,
    addConnection,
    removeConnection,
    mountConnection,
    unmountConnection,
    syncConnection,
  };
}
