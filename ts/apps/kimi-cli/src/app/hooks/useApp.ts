/**
 * Application state management hook.
 *
 * Manages the `AppState` with a simple reducer-style `setState(patch)`
 * pattern. Components call `useAppState()` to read/update the state.
 */

import { useCallback, useState } from 'react';

import type { AppState } from '../context.js';

export interface UseAppStateResult {
  state: AppState;
  setState: (patch: Partial<AppState>) => void;
}

export function useAppState(initial: AppState): UseAppStateResult {
  const [state, setRawState] = useState<AppState>(initial);

  const setState = useCallback((patch: Partial<AppState>) => {
    setRawState((prev) => ({ ...prev, ...patch }));
  }, []);

  return { state, setState };
}
