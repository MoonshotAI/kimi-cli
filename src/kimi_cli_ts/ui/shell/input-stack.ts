/**
 * input-stack.ts — Input focus stack for layered keyboard handling.
 *
 * Components can push themselves onto the input stack to capture keyboard
 * events. Only the handler at the top of the stack receives normal key
 * events. Global hotkeys (Ctrl+C, Esc) always fire regardless of stack.
 *
 * Usage in a component:
 *   useInputLayer((input, key) => { ... handle keys ... });
 *
 * When the component unmounts, the layer is automatically removed.
 * The previous layer resumes receiving events.
 *
 * The central useInput in input-state.ts calls dispatchToStack() which
 * routes events to the top handler, or falls through to the default
 * handler if the stack is empty.
 */

import { useEffect, useRef } from "react";

// ── Types ───────────────────────────────────────────────

export type InputKey = {
	upArrow?: boolean;
	downArrow?: boolean;
	leftArrow?: boolean;
	rightArrow?: boolean;
	return?: boolean;
	escape?: boolean;
	ctrl?: boolean;
	shift?: boolean;
	tab?: boolean;
	backspace?: boolean;
	delete?: boolean;
	meta?: boolean;
};

export type InputHandler = (input: string, key: InputKey) => void;

// ── Stack ───────────────────────────────────────────────

type StackEntry = {
	id: number;
	handler: InputHandler;
};

let nextId = 0;
const stack: StackEntry[] = [];

/**
 * Push a handler onto the input stack. Returns an id for removal.
 */
function pushLayer(handler: InputHandler): number {
	const id = nextId++;
	stack.push({ id, handler });
	return id;
}

/**
 * Remove a handler from the stack by id.
 */
function popLayer(id: number): void {
	const idx = stack.findIndex((e) => e.id === id);
	if (idx !== -1) stack.splice(idx, 1);
}

/**
 * Get the current top handler, or null if stack is empty.
 */
export function getTopHandler(): InputHandler | null {
	return stack.length > 0 ? stack[stack.length - 1]!.handler : null;
}

/**
 * Check if any layers are on the stack.
 */
export function hasLayers(): boolean {
	return stack.length > 0;
}

// ── Hook ────────────────────────────────────────────────

/**
 * Push an input handler layer for the lifetime of the calling component.
 * While this layer is active, it receives all non-global key events.
 * When the component unmounts, the layer is automatically removed.
 *
 * The handler is kept in a ref so it can be updated without
 * removing/re-adding the layer.
 */
export function useInputLayer(handler: InputHandler): void {
	const handlerRef = useRef(handler);
	handlerRef.current = handler;

	const idRef = useRef<number | null>(null);

	useEffect(() => {
		const stableHandler: InputHandler = (input, key) => {
			handlerRef.current(input, key);
		};
		idRef.current = pushLayer(stableHandler);

		return () => {
			if (idRef.current !== null) {
				popLayer(idRef.current);
				idRef.current = null;
			}
		};
	}, []); // Mount/unmount only
}
