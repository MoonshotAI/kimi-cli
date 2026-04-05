/**
 * useShellLayout.ts — Terminal height tracking and static items computation.
 */

import React, { useEffect, useState } from "react";
import { useStdout } from "ink";
import type { UIMessage } from "./events.ts";

type WelcomeItem = { id: string; _isWelcome: true };
type StaticItem = WelcomeItem | UIMessage;

/** Prepare the static (already-flushed) items for Ink's <Static>. */
export function buildStaticItems(messages: UIMessage[], isStreaming: boolean): StaticItem[] {
  const welcome: WelcomeItem = { id: "__welcome__", _isWelcome: true as const };
  const msgs = isStreaming ? messages.slice(0, -1) : messages;
  return [welcome, ...msgs];
}

/** Hook that tracks terminal height and exposes layout helpers. */
export function useShellLayout(messages: UIMessage[], isStreaming: boolean) {
  const { stdout } = useStdout();
  const [termHeight, setTermHeight] = useState(stdout?.rows || 24);

  useEffect(() => {
    const onResize = () => setTermHeight(stdout?.rows || 24);
    stdout?.on("resize", onResize);
    return () => { stdout?.off("resize", onResize); };
  }, [stdout]);

  const staticItems = React.useMemo(
    () => buildStaticItems(messages, isStreaming),
    [messages, isStreaming],
  );

  return { termHeight, staticItems };
}
