/**
 * Top-level Ink application component.
 *
 * Initialises the AppContext with state, Wire client hooks, and renders
 * the <Shell> component. All children can access the context via
 * `useContext(AppContext)`.
 */

import React, { useMemo } from 'react';

import type { WireClient } from '@moonshot-ai/kimi-wire-mock';

import { AppContext } from './context.js';
import type { AppState } from './context.js';
import { useAppState } from './hooks/useApp.js';
import { useWire } from './hooks/useWire.js';
import { createThemeStyles } from '../theme/styles.js';
import Shell from '../components/Shell.js';

export interface AppProps {
  readonly wireClient: WireClient;
  readonly initialState: AppState;
}

export default function App({ wireClient, initialState }: AppProps): React.JSX.Element {
  const { state, setState } = useAppState(initialState);
  const {
    completedBlocks,
    pushBlock,
    streamingText,
    setStreamingText,
    sendMessage,
    cancelStream,
  } = useWire(wireClient, setState);

  const styles = useMemo(() => createThemeStyles(state.theme), [state.theme]);

  const contextValue = {
    state,
    setState,
    wireClient,
    styles,
    completedBlocks,
    pushBlock,
    streamingText,
    setStreamingText,
    sendMessage,
    cancelStream,
  };

  return (
    <AppContext.Provider value={contextValue}>
      <Shell />
    </AppContext.Provider>
  );
}
