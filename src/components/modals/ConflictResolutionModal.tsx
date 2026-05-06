import { useState, useEffect } from 'react';
import Text from '../ui/Text';
import { TextVariants } from '../../types/typography';
import { invoke } from '@tauri-apps/api/core';
import { Invokes } from '../ui/AppProperties';

interface ConflictResolutionModalProps {
  isOpen: boolean;
  onClose(): void;
  connectionId: string;
  conflicts: string[];
  onResolved(): void;
}

export default function ConflictResolutionModal({
  isOpen,
  onClose,
  connectionId,
  conflicts,
  onResolved,
}: ConflictResolutionModalProps) {
  const [isMounted, setIsMounted] = useState(false);
  const [show, setShow] = useState(false);
  const [resolving, setResolving] = useState<Set<string>>(new Set());
  const [resolved, setResolved] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (isOpen) {
      setIsMounted(true);
      setResolved(new Set());
      const timer = setTimeout(() => setShow(true), 10);
      return () => clearTimeout(timer);
    } else {
      setShow(false);
      const timer = setTimeout(() => {
        setIsMounted(false);
        setResolving(new Set());
      }, 300);
      return () => clearTimeout(timer);
    }
  }, [isOpen]);

  const handleResolve = async (path: string, strategy: 'KeepLocal' | 'KeepRemote') => {
    setResolving((prev) => new Set(prev).add(path));
    try {
      await invoke(Invokes.RoamfsResolveConflict, {
        id: connectionId,
        path,
        strategy,
      });
      setResolved((prev) => new Set(prev).add(path));
    } catch (err) {
      console.error('Failed to resolve conflict:', err);
    } finally {
      setResolving((prev) => {
        const next = new Set(prev);
        next.delete(path);
        return next;
      });
    }
  };

  const remainingConflicts = conflicts.filter((c) => !resolved.has(c));

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
          bg-surface rounded-lg shadow-xl p-6 w-full max-w-lg
          transform transition-all duration-300 ease-out
          ${show ? 'scale-100 opacity-100 translate-y-0' : 'scale-95 opacity-0 -translate-y-4'}
        `}
        onClick={(e) => e.stopPropagation()}
      >
        <Text variant={TextVariants.title} className="mb-2">
          Sync Conflicts Detected
        </Text>
        <Text className="mb-4 text-text-secondary">
          {remainingConflicts.length === 0
            ? 'All conflicts have been resolved.'
            : `${remainingConflicts.length} file(s) have conflicting changes. Choose which version to keep.`}
        </Text>

        <div className="max-h-80 overflow-y-auto space-y-2">
          {conflicts.map((path) => {
            const isResolved = resolved.has(path);
            const isResolving = resolving.has(path);
            return (
              <div
                key={path}
                className={`flex items-center justify-between p-3 rounded-md border ${
                  isResolved
                    ? 'border-green-500/30 bg-green-500/10'
                    : 'border-border bg-bg-primary'
                }`}
              >
                <span className="text-sm truncate flex-1 mr-3">{path}</span>
                {isResolved ? (
                  <Text className="text-green-400 text-sm font-medium">Resolved</Text>
                ) : (
                  <div className="flex gap-2 shrink-0">
                    <button
                      className="px-3 py-1.5 rounded-md text-sm bg-bg-primary hover:bg-card-active border border-border transition-colors disabled:opacity-50"
                      disabled={isResolving}
                      onClick={() => handleResolve(path, 'KeepLocal')}
                    >
                      {isResolving ? '...' : 'Keep Local'}
                    </button>
                    <button
                      className="px-3 py-1.5 rounded-md text-sm bg-accent text-button-text hover:bg-accent-hover transition-colors disabled:opacity-50"
                      disabled={isResolving}
                      onClick={() => handleResolve(path, 'KeepRemote')}
                    >
                      {isResolving ? '...' : 'Keep Remote'}
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div className="flex justify-end gap-3 mt-5">
          <button
            className="px-4 py-2 rounded-md text-text-secondary hover:bg-surface transition-colors"
            onClick={() => {
              onClose();
              if (remainingConflicts.length === 0) onResolved();
            }}
          >
            {remainingConflicts.length === 0 ? 'Done' : 'Close'}
          </button>
        </div>
      </div>
    </div>
  );
}
