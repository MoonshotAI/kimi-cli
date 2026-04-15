/**
 * Spinner component -- context-aware streaming indicator.
 *
 * Only shows during the "waiting" phase (before first token arrives).
 * Uses moon phase animation: 🌑🌒🌓🌔🌕🌖🌗🌘
 *
 * Once content starts streaming (composing/thinking), the spinner hides.
 */

import React, { useContext, useState, useEffect } from 'react';
import { Box, Text } from 'ink';

import { AppContext } from '../app/context.js';

const MOON_PHASES = ['🌑', '🌒', '🌓', '🌔', '🌕', '🌖', '🌗', '🌘'];
const MOON_INTERVAL = 120;

export default function Spinner(): React.JSX.Element | null {
  const { state } = useContext(AppContext);
  const [frame, setFrame] = useState(0);

  // Only show during 'waiting' phase (before first token).
  const isActive = state.streamingPhase === 'waiting';

  useEffect(() => {
    if (!isActive) return;
    const timer = setInterval(() => {
      setFrame((f) => f + 1);
    }, MOON_INTERVAL);
    return () => clearInterval(timer);
  }, [isActive]);

  if (!isActive) {
    return null;
  }

  return (
    <Box marginTop={1}>
      <Text>{MOON_PHASES[frame % MOON_PHASES.length]}</Text>
    </Box>
  );
}
