/**
 * NotificationToast — Slice 4.4 Part 2.
 *
 * Renders the active queue of shell-target notifications as a
 * vertical stack of coloured banners at the top of the Shell. Each
 * toast is driven by `useWire`'s `toasts` state; an entry enters when
 * `NotificationManager.emit(...)` targets the shell, and auto-expires
 * after `TOAST_TTL_MS` via a timer inside `useWire`. We do not poll
 * or own any timers here — the component is pure render.
 */

import { Box, Text } from 'ink';
import React, { useContext } from 'react';

import { AppContext } from '../app/context.js';

const SEVERITY_COLOR: Record<string, string> = {
  info: 'cyan',
  success: 'green',
  warning: 'yellow',
  error: 'red',
};

export default function NotificationToast(): React.JSX.Element | null {
  const { toasts } = useContext(AppContext);

  if (toasts.length === 0) return null;

  return (
    <Box flexDirection="column" marginTop={1}>
      {toasts.map((toast) => {
        const color = SEVERITY_COLOR[toast.severity] ?? 'cyan';
        return (
          <Box
            key={toast.id}
            flexDirection="column"
            borderStyle="round"
            borderColor={color}
            paddingX={1}
          >
            <Text color={color} bold>
              {toast.title}
            </Text>
            {toast.body.length > 0 ? <Text>{toast.body}</Text> : null}
          </Box>
        );
      })}
    </Box>
  );
}
