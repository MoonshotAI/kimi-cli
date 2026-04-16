/**
 * Spinner component.
 *
 * Uses moon phase animation: 🌑🌒🌓🌔🌕🌖🌗🌘
 */

import { Box, Text } from 'ink';
import React, { useEffect, useState } from 'react';

const MOON_PHASES = ['🌑', '🌒', '🌓', '🌔', '🌕', '🌖', '🌗', '🌘'];
const MOON_INTERVAL = 120;

export interface SpinnerProps {
  readonly active: boolean;
}

export default function Spinner({ active }: SpinnerProps): React.JSX.Element | null {
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => {
      setFrame((f) => f + 1);
    }, MOON_INTERVAL);
    return () => clearInterval(timer);
  }, [active]);

  if (!active) {
    return null;
  }

  return <Box><Text>{MOON_PHASES[frame % MOON_PHASES.length]}</Text></Box>;
}
