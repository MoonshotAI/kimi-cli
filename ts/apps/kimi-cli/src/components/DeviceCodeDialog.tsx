/**
 * DeviceCodeDialog — standalone Ink renderer for the OAuth device flow.
 *
 * Renders independently of the main Shell so it can appear BEFORE a TUI
 * session exists (e.g. first-boot login). A simple state-machine snapshot
 * is accepted via props; the host drives state transitions externally.
 */

import { Box, Text } from 'ink';
import React from 'react';

export type DeviceCodeState =
  | { readonly status: 'requesting' }
  | {
      readonly status: 'pending';
      readonly userCode: string;
      readonly verificationUri: string;
      readonly verificationUriComplete: string;
    }
  | { readonly status: 'success' }
  | { readonly status: 'error'; readonly message: string };

export interface DeviceCodeDialogProps {
  readonly state: DeviceCodeState;
  /** Provider name displayed in the header (e.g. "kimi-code"). */
  readonly providerName: string;
}

export default function DeviceCodeDialog(props: DeviceCodeDialogProps): React.JSX.Element {
  const { state, providerName } = props;
  return (
    <Box flexDirection="column" paddingY={1} paddingX={2}>
      <Box marginBottom={1}>
        <Text bold color="cyan">
          ▶ OAuth login: {providerName}
        </Text>
      </Box>
      {state.status === 'requesting' && (
        <Text color="gray">Requesting device authorization…</Text>
      )}
      {state.status === 'pending' && (
        <>
          <Box marginBottom={1}>
            <Text>Please visit the URL below to authorize this device:</Text>
          </Box>
          <Box
            borderStyle="round"
            borderColor="cyan"
            paddingX={1}
            marginBottom={1}
            flexDirection="column"
          >
            <Text color="cyan" bold>
              {state.verificationUriComplete}
            </Text>
          </Box>
          <Box marginBottom={1}>
            <Text>
              Code: <Text color="yellow" bold>{state.userCode}</Text>
            </Text>
          </Box>
          <Text color="gray">
            Waiting for authorization… Press Ctrl-C to cancel.
          </Text>
        </>
      )}
      {state.status === 'success' && (
        <Text color="green">✓ Authorized successfully.</Text>
      )}
      {state.status === 'error' && (
        <Text color="red">✗ {state.message}</Text>
      )}
    </Box>
  );
}
