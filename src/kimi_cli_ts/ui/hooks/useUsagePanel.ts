/**
 * useUsagePanel.ts — Hook for managing the /usage panel state.
 *
 * Handles:
 * - Visibility toggle
 * - Loading state while fetching
 * - Caching fetched data
 * - Error handling
 */

import { useState, useCallback } from "react";
import { fetchAndParseUsage } from "../shell/commands/usage.ts";
import type { UsageRow } from "../shell/UsagePanel.tsx";
import type { Config } from "../../config.ts";

export interface UsagePanelState {
	visible: boolean;
	loading: boolean;
	error: string | null;
	summary: UsageRow | null;
	limits: UsageRow[];
}

export interface UseUsagePanelReturn extends UsagePanelState {
	show: (config: Config, modelKey: string | undefined) => Promise<void>;
	hide: () => void;
	reset: () => void;
}

const initialState: UsagePanelState = {
	visible: false,
	loading: false,
	error: null,
	summary: null,
	limits: [],
};

export function useUsagePanel(): UseUsagePanelReturn {
	const [state, setState] = useState<UsagePanelState>(initialState);

	const show = useCallback(
		async (config: Config, modelKey: string | undefined) => {
			setState({ ...initialState, visible: true, loading: true });

			try {
				const result = await fetchAndParseUsage(config, modelKey);
				setState({
					visible: true,
					loading: false,
					error: result.error || null,
					summary: result.summary,
					limits: result.limits,
				});
			} catch (err) {
				setState({
					visible: true,
					loading: false,
					error: `Unexpected error: ${err instanceof Error ? err.message : err}`,
					summary: null,
					limits: [],
				});
			}
		},
		[],
	);

	const hide = useCallback(() => {
		setState(initialState);
	}, []);

	const reset = useCallback(() => {
		setState(initialState);
	}, []);

	return {
		...state,
		show,
		hide,
		reset,
	};
}
