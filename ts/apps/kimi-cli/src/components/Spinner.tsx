/**
 * Spinner component -- context-aware streaming indicator.
 *
 * Two modes:
 *  1. "waiting" phase (before first token): moon phase animation 🌑🌒🌓...
 *  2. "thinking"/"composing" phase: dots spinner + label + elapsed time
 *     e.g. "⠋ Thinking... 3s" or "⠋ Composing... 5s"
 */

import React, { useContext, useState, useEffect } from 'react';
import { Box, Text } from 'ink';

import { AppContext } from '../app/context.js';

const MOON_PHASES = ['🌑', '🌒', '🌓', '🌔', '🌕', '🌖', '🌗', '🌘'];
const DOTS_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const MOON_INTERVAL = 120;
const DOTS_INTERVAL = 80;

function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${String(s)}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${String(m)}m${String(rem)}s`;
}

export default function Spinner(): React.JSX.Element | null {
  const { state, styles } = useContext(AppContext);
  const [frame, setFrame] = useState(0);
  const [elapsed, setElapsed] = useState(0);

  const phase = state.streamingPhase;
  const isActive = phase === 'waiting' || phase === 'composing';

  // Animate frames
  useEffect(() => {
    if (!isActive) return;
    const interval = phase === 'waiting' ? MOON_INTERVAL : DOTS_INTERVAL;
    const timer = setInterval(() => {
      setFrame((f) => f + 1);
    }, interval);
    return () => clearInterval(timer);
  }, [isActive, phase]);

  // Track elapsed time
  useEffect(() => {
    if (!isActive) {
      setElapsed(0);
      return;
    }
    const timer = setInterval(() => {
      setElapsed(Date.now() - state.streamingStartTime);
    }, 1000);
    return () => clearInterval(timer);
  }, [isActive, state.streamingStartTime]);

  if (!isActive) {
    return null;
  }

  // Moon spinner: before first token
  if (phase === 'waiting') {
    return (
      <Box marginTop={1}>
        <Text>{MOON_PHASES[frame % MOON_PHASES.length]}</Text>
      </Box>
    );
  }

  // Dots spinner: during composing
  const label = 'Composing...';
  const dot = DOTS_FRAMES[frame % DOTS_FRAMES.length];
  const elapsedStr = formatElapsed(elapsed);

  return (
    <Box>
      <Text color={styles.colors.textDim}>
        {dot} {label}
        <Text color={styles.colors.textMuted}> {elapsedStr}</Text>
      </Text>
    </Box>
  );
}
