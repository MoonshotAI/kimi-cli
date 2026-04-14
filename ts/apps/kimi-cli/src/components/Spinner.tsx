/**
 * Moon spinner component -- shown while an assistant turn is streaming.
 *
 * Cycles through moon phase emoji (🌑🌒🌓🌔🌕🌖🌗🌘), matching the
 * Python version's Rich `Spinner("moon")` style.
 */

import React, { useContext, useState, useEffect } from 'react';
import { Box, Text } from 'ink';

import { AppContext } from '../app/context.js';

const MOON_PHASES = ['🌑', '🌒', '🌓', '🌔', '🌕', '🌖', '🌗', '🌘'];
const INTERVAL_MS = 120;

export default function Spinner(): React.JSX.Element | null {
  const { state } = useContext(AppContext);
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    if (!state.isStreaming) return;
    const timer = setInterval(() => {
      setFrame((f) => (f + 1) % MOON_PHASES.length);
    }, INTERVAL_MS);
    return () => clearInterval(timer);
  }, [state.isStreaming]);

  if (!state.isStreaming) {
    return null;
  }

  return (
    <Box>
      <Text>{MOON_PHASES[frame]}</Text>
    </Box>
  );
}
