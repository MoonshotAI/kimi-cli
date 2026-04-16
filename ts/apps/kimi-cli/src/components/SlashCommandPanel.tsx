import { Box, Text } from 'ink';
import React from 'react';

import { useChrome } from '../app/context.js';
import type { SlashCommandDef } from '../slash/registry.js';

const MAX_CMD_NAME_WIDTH = 20;

export interface SlashCommandPanelProps {
  readonly commands: SlashCommandDef[];
  readonly selectedIndex: number;
  readonly maxVisible?: number;
  readonly width: number;
}

export default function SlashCommandPanel({
  commands,
  selectedIndex,
  maxVisible = 8,
  width,
}: SlashCommandPanelProps): React.JSX.Element | null {
  const { styles } = useChrome();

  if (commands.length === 0) return null;

  const total = commands.length;
  const visibleCount = Math.min(total, maxVisible);
  let start = selectedIndex - Math.floor(visibleCount / 2);
  start = Math.max(0, Math.min(start, total - visibleCount));
  const visible = commands.slice(start, start + visibleCount);

  const descMaxWidth = Math.max(10, width - MAX_CMD_NAME_WIDTH - 4);

  return (
    <Box flexDirection="column">
      {visible.map((cmd, i) => {
        const globalIdx = start + i;
        const isSelected = globalIdx === selectedIndex;
        const nameStr = `/${cmd.name}`;
        const padding = ' '.repeat(Math.max(2, MAX_CMD_NAME_WIDTH - nameStr.length));
        const desc =
          cmd.description.length > descMaxWidth
            ? cmd.description.slice(0, descMaxWidth - 1) + '…'
            : cmd.description;

        if (isSelected) {
          return (
            <Text key={cmd.name} inverse>
              {' '}
              {nameStr}
              {padding}
              {desc}
            </Text>
          );
        }

        return (
          <Text key={cmd.name}>
            {' '}
            <Text color={styles.colors.primary}>{nameStr}</Text>
            {padding}
            <Text color={styles.colors.textDim}>{desc}</Text>
          </Text>
        );
      })}
      {total > visibleCount ? (
        <Text color={styles.colors.textMuted}>
          {' '}
          {`${String(start + 1)}-${String(start + visibleCount)} / ${String(total)}`}
        </Text>
      ) : null}
    </Box>
  );
}
