/**
 * Top-level Ink application component.
 *
 * Initialises the AppContext with state, Wire client hooks, session
 * management, and renders the <Shell> component. All children can
 * access the context via `useContext(AppContext)`.
 */

import React, { useMemo, useState } from 'react';

import Shell from '../components/Shell.js';
import { createThemeStyles } from '../theme/styles.js';
import type { WireClient } from '../wire/index.js';
import { AppContext } from './context.js';
import type { AppState } from './context.js';
import { useAppState } from './hooks/useApp.js';
import { useSession } from './hooks/useSession.js';
import { useWire } from './hooks/useWire.js';

export interface AppProps {
  readonly wireClient: WireClient;
  readonly initialState: AppState;
}

export default function App({ wireClient, initialState }: AppProps): React.JSX.Element {
  const { state, setState } = useAppState(initialState);
  const {
    completedBlocks,
    pushBlock,
    streamingThinkText,
    streamingText,
    setStreamingText,
    sendMessage,
    cancelStream,
    pendingToolCall,
    pendingApproval,
    handleApprovalResponse,
    pendingQuestion,
    handleQuestionResponse,
    toasts,
    dismissToast,
  } = useWire(wireClient, state.sessionId, setState);

  const { sessions, loadingSessions, refreshSessions, switchSession } = useSession({
    wireClient,
    sessionId: state.sessionId,
    setState,
  });

  const [showSessionPicker, setShowSessionPicker] = useState(false);

  const styles = useMemo(() => createThemeStyles(state.theme), [state.theme]);

  const contextValue = {
    state,
    setState,
    wireClient,
    styles,
    completedBlocks,
    pushBlock,
    streamingThinkText,
    streamingText,
    setStreamingText,
    sendMessage,
    cancelStream,
    pendingToolCall,
    pendingApproval,
    handleApprovalResponse,
    pendingQuestion,
    handleQuestionResponse,
    toasts,
    dismissToast,
    sessions,
    loadingSessions,
    refreshSessions,
    switchSession,
    showSessionPicker,
    setShowSessionPicker,
  };

  return (
    <AppContext.Provider value={contextValue}>
      <Shell />
    </AppContext.Provider>
  );
}
