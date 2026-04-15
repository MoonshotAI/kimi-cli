/**
 * Top-level Ink application component.
 *
 * Initialises the AppContext with state, Wire client hooks, session
 * management, slash command registry, and renders the <Shell> component.
 */

import React, { useCallback, useMemo, useState } from 'react';

import type { WireClient } from '../wire/index.js';

import { AppContext } from './context.js';
import type { AppState, CompletedBlock } from './context.js';
import { useAppState } from './hooks/useApp.js';
import { useWire } from './hooks/useWire.js';
import { useSession } from './hooks/useSession.js';
import { createThemeStyles } from '../theme/styles.js';
import { createDefaultRegistry, parseSlashInput } from '../slash/index.js';
import type { SlashCommandContext } from '../slash/index.js';
import Shell from '../components/Shell.js';

export interface AppProps {
  readonly wireClient: WireClient;
  readonly initialState: AppState;
}

let statusBlockCounter = 0;

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
  } = useWire(wireClient, state.sessionId, setState);

  const {
    sessions,
    loadingSessions,
    refreshSessions,
    switchSession,
  } = useSession({ wireClient, sessionId: state.sessionId, setState });

  const [showSessionPicker, setShowSessionPicker] = useState(false);

  const styles = useMemo(() => createThemeStyles(state.theme), [state.theme]);

  // Slash command registry (created once).
  const registry = useMemo(() => createDefaultRegistry(), []);

  // ── Slash command execution ────────────────────────────────────

  const executeSlashCommand = useCallback(
    async (input: string): Promise<string | null> => {
      const parsed = parseSlashInput(input);
      if (!parsed) return null;

      const def = registry.find(parsed.name);
      if (!def) return `Unknown command: /${parsed.name}`;

      const ctx: SlashCommandContext = {
        wireClient,
        appState: state,
        setAppState: setState,
      };

      const result = await def.execute(parsed.args, ctx);

      switch (result.type) {
        case 'exit':
          process.exit(0);
          break;
        case 'reload':
          // For now, just clear completed blocks by pushing a status message.
          // Full reload (new session) will be implemented later.
          return 'Session reset. (Full reload not yet implemented)';
        case 'ok': {
          if (!result.message) return null;

          // Special signals
          if (result.message === '__show_help__') {
            // Build help text from registry
            const cmds = registry.listAll();
            const lines = cmds.map((c) => {
              const aliases = c.aliases.length > 0 ? ` (${c.aliases.map((a) => '/' + a).join(', ')})` : '';
              return `  /${c.name}${aliases} -- ${c.description}`;
            });
            return 'Available commands:\n' + lines.join('\n');
          }

          if (result.message === '__show_sessions__') {
            await refreshSessions();
            setShowSessionPicker(true);
            return null;
          }

          if (result.message.startsWith('__send_as_message__:')) {
            const msg = result.message.slice('__send_as_message__:'.length);
            sendMessage(msg);
            return null;
          }

          return result.message;
        }
      }
      return null;
    },
    [wireClient, state, setState, registry, refreshSessions, setShowSessionPicker, sendMessage],
  );

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
    executeSlashCommand,
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
