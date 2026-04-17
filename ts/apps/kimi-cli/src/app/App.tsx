/**
 * Top-level Ink application component.
 *
 * Initializes the app state, session hooks, and the split render contexts
 * used by the shell.
 */

import React, { useCallback, useMemo, useState } from 'react';

import type { LoginOptions } from '@moonshot-ai/core';

import Shell from '../components/Shell.js';
import { createDefaultRegistry, parseSlashInput } from '../slash/index.js';
import type { SlashCommandContext } from '../slash/index.js';
import { createThemeStyles } from '../theme/styles.js';
import type { WireClient } from '../wire/index.js';
import type { AppState } from './context.js';
import {
  ActionsContext,
  ChromeContext,
  LiveTurnContext,
  ToastContext,
  TranscriptContext,
} from './context.js';
import { useAppState } from './hooks/useApp.js';
import { useSession } from './hooks/useSession.js';
import { useWire } from './hooks/useWire.js';

export interface AppOAuthManager {
  logout(): Promise<void>;
  login(options?: LoginOptions): Promise<unknown>;
  hasToken(): Promise<boolean>;
}

export interface AppProps {
  readonly wireClient: WireClient;
  readonly initialState: AppState;
  /**
   * Slice 5.0 — OAuth managers registered with `/logout`. Keys are
   * provider names (e.g. "managed:kimi-code"). When present and
   * non-empty, they are passed to `createDefaultRegistry` so slash
   * commands like `/login` and `/logout` use the pre-existing manager.
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
    transcriptEntries,
    appendTranscriptEntry,
    livePane,
    sendMessage,
    cancelStream,
    handleApprovalResponse,
    handleQuestionResponse,
    toasts,
    dismissToast,
    queuedMessages,
    enqueueMessage,
    removeFromQueue,
    editQueueItem,
    steerMessage,
    recallLastQueued,
    dequeueFirst,
  } = useWire(wireClient, state.sessionId, setState);

  const { sessions, loadingSessions, refreshSessions, switchSession } = useSession({
    wireClient,
    sessionId: state.sessionId,
    setState,
  });

  const [showSessionPicker, setShowSessionPicker] = useState(false);

  const styles = useMemo(() => createThemeStyles(state.theme), [state.theme]);

  const registry = useMemo(() => {
    if (oauthManagers !== undefined && oauthManagers.size > 0) {
      const managersMap = new Map<string, AppOAuthManager>();
      for (const [name, mgr] of oauthManagers) {
        managersMap.set(name, mgr);
      }
      const firstName = [...oauthManagers.keys()][0];
      return createDefaultRegistry({
        managers: managersMap,
        ...(firstName !== undefined ? { defaultProviderName: firstName } : {}),
      });
    }
    return createDefaultRegistry();
  }, [oauthManagers]);

  // ── Slash command execution ────────────────────────────────────

  const executeSlashCommand = useCallback(
    async (input: string): Promise<{ message: string; color?: string } | null> => {
      const parsed = parseSlashInput(input);
      if (!parsed) return null;

      const def = registry.find(parsed.name);
      if (!def) return { message: `Unknown command: /${parsed.name}` };

      const ctx: SlashCommandContext = {
        wireClient,
        appState: state,
        setAppState: setState,
        showStatus: (message: string) => {
          appendTranscriptEntry({
            id: `status-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            kind: 'status',
            renderMode: 'plain',
            content: message,
          });
        },
      };

      let result;
      try {
        result = await def.execute(parsed.args, ctx);
      } catch (error) {
        // Slash command implementations may throw (e.g. setModel stub).
        // Surface as a status message instead of letting the rejection
        // escape to an unhandled promise.
        return { message: error instanceof Error ? error.message : String(error) };
      }

      switch (result.type) {
        case 'exit':
          process.exit(0);
          break;
        case 'reload':
          // For now, just clear completed blocks by pushing a status message.
          // Full reload (new session) will be implemented later.
          return { message: 'Session reset. (Full reload not yet implemented)' };
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
            return { message: 'Available commands:\n' + lines.join('\n') };
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

          return { message: result.message, ...(result.color !== undefined ? { color: result.color } : {}) };
        }
      }
      return null;
    },
    [wireClient, state, setState, registry, refreshSessions, setShowSessionPicker, sendMessage, appendTranscriptEntry],
  );

  const transcriptValue = useMemo(
    () => ({ entries: transcriptEntries }),
    [transcriptEntries],
  );

  const liveTurnValue = useMemo(
    () => ({ pane: showSessionPicker ? { ...livePane, mode: 'session' as const } : livePane }),
    [livePane, showSessionPicker],
  );

  const toastValue = useMemo(() => ({ toasts }), [toasts]);

  const chromeValue = useMemo(
    () => ({
      state,
      setState,
      wireClient,
      styles,
      sessions,
      loadingSessions,
      showSessionPicker,
      registry,
    }),
    [state, setState, wireClient, styles, sessions, loadingSessions, showSessionPicker, registry],
  );

  const actionsValue = useMemo(
    () => ({
      appendTranscriptEntry,
      sendMessage,
      cancelStream,
      handleApprovalResponse,
      handleQuestionResponse,
      dismissToast,
      executeSlashCommand,
      refreshSessions,
      switchSession,
      setShowSessionPicker,
      enqueueMessage,
      steerMessage,
      removeFromQueue,
      editQueueItem,
      recallLastQueued,
      dequeueFirst,
      queuedMessages,
    }),
    [
      appendTranscriptEntry,
      sendMessage,
      cancelStream,
      handleApprovalResponse,
      handleQuestionResponse,
      dismissToast,
      executeSlashCommand,
      refreshSessions,
      switchSession,
      setShowSessionPicker,
      enqueueMessage,
      steerMessage,
      removeFromQueue,
      editQueueItem,
      recallLastQueued,
      dequeueFirst,
      queuedMessages,
    ],
  );

  return (
    <TranscriptContext.Provider value={transcriptValue}>
      <LiveTurnContext.Provider value={liveTurnValue}>
        <ToastContext.Provider value={toastValue}>
          <ChromeContext.Provider value={chromeValue}>
            <ActionsContext.Provider value={actionsValue}>
              <Shell />
            </ActionsContext.Provider>
          </ChromeContext.Provider>
        </ToastContext.Provider>
      </LiveTurnContext.Provider>
    </TranscriptContext.Provider>
  );
}
