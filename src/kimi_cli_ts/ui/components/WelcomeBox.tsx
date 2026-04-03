/**
 * WelcomeBox.tsx — Welcome panel displayed on first render.
 * Matches Python's welcome box layout with logo, directory, session, model info.
 */

import React from "react";
import { Box, Text } from "ink";

const KIMI_BLUE = "#1e90ff";

interface WelcomeBoxProps {
  workDir?: string;
  sessionId?: string;
  modelName?: string;
  poweredBy?: string;
  tip?: string;
}

export function WelcomeBox({
  workDir,
  sessionId,
  modelName,
  poweredBy,
  tip,
}: WelcomeBoxProps) {
  // Shorten home directory
  const home = process.env.HOME || process.env.USERPROFILE || "";
  const displayDir = workDir
    ? workDir.startsWith(home)
      ? "~" + workDir.slice(home.length)
      : workDir
    : "~";

  return (
    <Box
      borderStyle="round"
      borderColor={KIMI_BLUE}
      flexDirection="column"
      paddingX={1}
      paddingY={1}
    >
      {/* Logo + Welcome */}
      <Box>
        <Box flexDirection="column" marginRight={2}>
          <Text color={KIMI_BLUE} bold>▐█▛█▛█▌</Text>
          <Text color={KIMI_BLUE} bold>▐█████▌</Text>
        </Box>
        <Box flexDirection="column" justifyContent="center">
          <Text bold>Welcome to Kimi Code CLI!</Text>
          <Text color="#888888">Send /help for help information.</Text>
        </Box>
      </Box>

      {/* Blank line */}
      <Text> </Text>

      {/* Directory */}
      <Text>
        <Text color="#888888">  Directory: </Text>
        <Text>{displayDir}</Text>
      </Text>

      {/* Session */}
      {sessionId && (
        <Text>
          <Text color="#888888">  Session: </Text>
          <Text>{sessionId}</Text>
        </Text>
      )}

      {/* Model */}
      <Text>
        <Text color="#888888">  Model: </Text>
        {modelName ? (
          <Text>
            {modelName}
            {poweredBy && poweredBy !== modelName && (
              <Text color="#888888"> (powered by {poweredBy})</Text>
            )}
          </Text>
        ) : (
          <Text color="yellow">not set, send /login to login</Text>
        )}
      </Text>

      {/* Tip */}
      {tip && (
        <>
          <Text> </Text>
          <Text>
            <Text color="#888888">  Tip: </Text>
            <Text>{tip}</Text>
          </Text>
        </>
      )}
    </Box>
  );
}
