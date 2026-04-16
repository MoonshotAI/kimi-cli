/**
 * Top-level Ink application component.
 *
 * Initialises the AppContext with state, Wire client hooks, session
 * management, slash command registry, and renders the <Shell> component.
 */

import React, { useCallback, useMemo, useState } from 'react';

import Shell from '../components/Shell.js';
import { createDefaultRegistry, parseSlashInput } from '../slash/index.js';
import type { SlashCommandContext } from '../slash/index.js';
import { createAuthCommands } from '../slash/auth-commands.js';
import { createThemeStyles } from '../theme/styles.js';
import type { WireClient } from '../wire/index.js';
import { AppContext } from './context.js';
import type { AppState } from './context.js';
import { useAppState } from './hooks/useApp.js';
import { useSession } from './hooks/useSession.js';
import { useWire } from './hooks/useWire.js';

export interface AppOAuthManager {
  logout(): Promise<void>;
  hasToken(): Promise<boolean>;
}

export interface AppProps {
  readonly wireClient: WireClient;
  readonly initialState: AppState;
  /**
   * Slice 5.0 — OAuth managers registered with `/logout`. Keys are
   * provider names (e.g. "managed:kimi-code"). When present and
   * non-empty, `createAuthCommands` is merged into the default
   * registry.
   */
  readonly oauthManagers?: ReadonlyMap<string, AppOAuthManager> | undefined;
}

export default function App({
  wireClient,
  initialState,
  oauthManagers,
}: AppProps): React.JSX.Element {
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

  // Slash command registry (created once). Auth commands are registered when
  // the host injects OAuth managers (Slice 5.0).
  const registry = useMemo(() => {
    const reg = createDefaultRegistry();
    if (oauthManagers !== undefined && oauthManagers.size > 0) {
      const managersMap = new Map<string, { logout: () => Promise<void> }>();
      for (const [name, mgr] of oauthManagers) {
        managersMap.set(name, mgr);
      }
      const firstName = [...oauthManagers.keys()][0];
      for (const cmd of createAuthCommands({
        managers: managersMap,
        ...(firstName !== undefined ? { defaultProviderName: firstName } : {}),
      })) {
        reg.register(cmd);
      }
    }
    return reg;
  }, [oauthManagers]);

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

      let result;
      try {
        result = await def.execute(parsed.args, ctx);
      } catch (error) {
        // Slash command implementations may throw (e.g. setModel stub).
        // Surface as a status message instead of letting the rejection
        // escape to an unhandled promise.
        return error instanceof Error ? error.message : String(error);
      }

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
              const aliases =
                c.aliases.length > 0 ? ` (${c.aliases.map((a) => '/' + a).join(', ')})` : '';
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
    pendingQuestion,
    handleQuestionResponse,
    toasts,
    dismissToast,
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
