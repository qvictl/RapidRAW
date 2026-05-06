import { useState, useEffect, useCallback } from 'react';
import Text from '../ui/Text';
import { TextVariants } from '../../types/typography';
import { invoke } from '@tauri-apps/api/core';
import { Invokes } from '../ui/AppProperties';
import type { RemoteConnection } from '../../store/useUIStore';

interface RemoteConnectionModalProps {
  isOpen: boolean;
  onClose(): void;
  connection: RemoteConnection | null;
  onSave(connection: RemoteConnection): void;
}

export default function RemoteConnectionModal({
  isOpen,
  onClose,
  connection,
  onSave,
}: RemoteConnectionModalProps) {
  const [name, setName] = useState('');
  const [uri, setUri] = useState('');
  const [cacheDir, setCacheDir] = useState('');
  const [maxCacheMib, setMaxCacheMib] = useState(1024);
  const [isTesting, setIsTesting] = useState(false);
  const [testResult, setTestResult] = useState<'idle' | 'success' | 'error'>('idle');
  const [isMounted, setIsMounted] = useState(false);
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (isOpen) {
      setIsMounted(true);
      const timer = setTimeout(() => setShow(true), 10);
      return () => clearTimeout(timer);
    } else {
      setShow(false);
      const timer = setTimeout(() => {
        setIsMounted(false);
        setTestResult('idle');
      }, 300);
      return () => clearTimeout(timer);
    }
  }, [isOpen]);

  useEffect(() => {
    if (connection) {
      setName(connection.name);
      setUri(connection.uri);
      setCacheDir(connection.cacheDir);
      setMaxCacheMib(connection.maxCacheMib);
    } else {
      setName('');
      setUri('');
      setCacheDir('');
      setMaxCacheMib(1024);
    }
  }, [connection]);

  const handleTest = useCallback(async () => {
    if (!uri.trim()) return;
    setIsTesting(true);
    setTestResult('idle');
    try {
      await invoke(Invokes.RoamfsTestConnection, { uri: uri.trim() });
      setTestResult('success');
    } catch {
      setTestResult('error');
    } finally {
      setIsTesting(false);
    }
  }, [uri]);

  const handleSave = useCallback(() => {
    if (!name.trim() || !uri.trim()) return;
    onSave({
      id: connection?.id || crypto.randomUUID(),
      name: name.trim(),
      uri: uri.trim(),
      cacheDir: cacheDir.trim(),
      maxCacheMib: Math.max(64, maxCacheMib),
    });
    onClose();
  }, [name, uri, cacheDir, maxCacheMib, connection, onSave, onClose]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && name.trim() && uri.trim()) {
        handleSave();
      } else if (e.key === 'Escape') {
        onClose();
      }
    },
    [handleSave, onClose, name, uri],
  );

  if (!isMounted) return null;

  return (
    <div
      aria-modal="true"
      className={`
        fixed inset-0 flex items-center justify-center z-50
        bg-black/30 backdrop-blur-xs
        transition-opacity duration-300 ease-in-out
        ${show ? 'opacity-100' : 'opacity-0'}
      `}
      onClick={onClose}
      role="dialog"
    >
      <div
        className={`
          bg-surface rounded-lg shadow-xl p-6 w-full max-w-md
          transform transition-all duration-300 ease-out
          ${show ? 'scale-100 opacity-100 translate-y-0' : 'scale-95 opacity-0 -translate-y-4'}
        `}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        <Text variant={TextVariants.title} className="mb-4">
          {connection ? 'Edit Remote Connection' : 'Add Remote Connection'}
        </Text>

        <div className="space-y-3">
          <div>
            <label className="block text-sm text-text-secondary mb-1">Display Name</label>
            <input
              autoFocus
              className="w-full bg-bg-primary text-text-primary border border-border rounded-md px-3 py-2 focus:outline-hidden focus:ring-2 focus:ring-accent"
              onChange={(e) => setName(e.target.value)}
              placeholder="My NAS"
              type="text"
              value={name}
            />
          </div>

          <div>
            <label className="block text-sm text-text-secondary mb-1">Remote URI</label>
            <input
              className="w-full bg-bg-primary text-text-primary border border-border rounded-md px-3 py-2 focus:outline-hidden focus:ring-2 focus:ring-accent"
              onChange={(e) => {
                setUri(e.target.value);
                setTestResult('idle');
              }}
              placeholder="sftp://user@host/path or webdav://..."
              type="text"
              value={uri}
            />
            <Text variant={TextVariants.small} className="mt-1 text-text-tertiary">
              Supports sftp://, webdav://, http://, local paths
            </Text>
          </div>

          <div>
            <label className="block text-sm text-text-secondary mb-1">Cache Directory (optional)</label>
            <input
              className="w-full bg-bg-primary text-text-primary border border-border rounded-md px-3 py-2 focus:outline-hidden focus:ring-2 focus:ring-accent"
              onChange={(e) => setCacheDir(e.target.value)}
              placeholder="Leave empty for default"
              type="text"
              value={cacheDir}
            />
          </div>

          <div>
            <label className="block text-sm text-text-secondary mb-1">Max Cache Size (MiB)</label>
            <input
              className="w-full bg-bg-primary text-text-primary border border-border rounded-md px-3 py-2 focus:outline-hidden focus:ring-2 focus:ring-accent"
              min={64}
              onChange={(e) => setMaxCacheMib(Number(e.target.value))}
              type="number"
              value={maxCacheMib}
            />
          </div>

          {testResult === 'success' && (
            <Text className="text-green-400 text-sm">Connection successful!</Text>
          )}
          {testResult === 'error' && (
            <Text className="text-red-400 text-sm">Connection failed. Check URI and network.</Text>
          )}
        </div>

        <div className="flex justify-end gap-3 mt-5">
          <button
            className="px-4 py-2 rounded-md text-text-secondary hover:bg-surface transition-colors"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            className="px-4 py-2 rounded-md bg-bg-primary text-text-primary hover:bg-card-active transition-colors disabled:opacity-50"
            disabled={!uri.trim() || isTesting}
            onClick={handleTest}
          >
            {isTesting ? 'Testing...' : 'Test Connection'}
          </button>
          <button
            className="px-4 py-2 rounded-md bg-accent text-button-text font-semibold hover:bg-accent-hover disabled:bg-gray-500 disabled:text-white disabled:cursor-not-allowed transition-colors"
            disabled={!name.trim() || !uri.trim()}
            onClick={handleSave}
          >
            {connection ? 'Update' : 'Add'}
          </button>
        </div>
      </div>
    </div>
  );
}
