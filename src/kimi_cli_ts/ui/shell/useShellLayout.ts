/**
 * useShellLayout.ts — Terminal height tracking and static items computation.
 */

import React, { useEffect, useRef, useState } from "react";
import { useStdout } from "ink";
import type { UIMessage } from "./events.ts";

type WelcomeItem = { id: string; _isWelcome: true };
type StaticItem = WelcomeItem | UIMessage;

/** Prepare the static (already-flushed) items for Ink's <Static>. */
export function buildStaticItems(
	messages: UIMessage[],
	isStreaming: boolean,
): StaticItem[] {
	const welcome: WelcomeItem = { id: "__welcome__", _isWelcome: true as const };
	const msgs = isStreaming ? messages.slice(0, -1) : messages;
	return [welcome, ...msgs];
}

/** Hook that tracks terminal height and exposes layout helpers. */
export function useShellLayout(messages: UIMessage[], isStreaming: boolean) {
	const { stdout } = useStdout();
	const [termHeight, setTermHeight] = useState(stdout?.rows || 24);

	// Monotonic counter incremented after resize settles (debounced).
	// Used as React key on Shell's root Box to force a full subtree rebuild,
	// which makes <Static> re-output all items at the new terminal width.
	// Shell's own hooks (useWire, useShellInput, etc.) are unaffected because
	// Shell itself does not unmount — only its returned JSX tree is rebuilt.
	const [resizeKey, setResizeKey] = useState(0);
	const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	useEffect(() => {
		const onResize = () => {
			setTermHeight(stdout?.rows || 24);

			if (debounceRef.current) clearTimeout(debounceRef.current);
			debounceRef.current = setTimeout(() => {
				debounceRef.current = null;
				setResizeKey((k) => k + 1);
			}, 300);
		};
		stdout?.on("resize", onResize);
		return () => {
			stdout?.off("resize", onResize);
			if (debounceRef.current) clearTimeout(debounceRef.current);
		};
	}, [stdout]);

	const staticItems = React.useMemo(
		() => buildStaticItems(messages, isStreaming),
		[messages, isStreaming],
	);

	return { termHeight, staticItems, resizeKey };
}
