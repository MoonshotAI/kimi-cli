/**
 * Spinner component — loading indicators.
 * Uses ink-spinner for animated spinners.
 */

import React from "react";
import { Box, Text } from "ink";
import InkSpinner from "ink-spinner";
import { getMessageColors } from "../theme";

interface SpinnerProps {
  /** Text to display next to the spinner */
  label?: string;
  /** Spinner color */
  color?: string;
}

export function Spinner({ label = "Thinking...", color }: SpinnerProps) {
  const colors = getMessageColors();
  const spinnerColor = color || colors.highlight;

  return (
    <Box>
      <Text color={spinnerColor}>
        <InkSpinner type="dots" />
      </Text>
      {label && (
        <Text color={colors.dim}> {label}</Text>
      )}
    </Box>
  );
}

interface CompactionSpinnerProps {
  /** Whether compaction is in progress */
  active: boolean;
}

export function CompactionSpinner({ active }: CompactionSpinnerProps) {
  if (!active) return null;
  return <Spinner label="Compacting context..." color="#f2cc60" />;
}

interface StreamingSpinnerProps {
  stepCount: number;
}

export function StreamingSpinner({ stepCount }: StreamingSpinnerProps) {
  return (
    <Spinner
      label={stepCount > 0 ? `Thinking... (step ${stepCount})` : "Thinking..."}
    />
  );
}
