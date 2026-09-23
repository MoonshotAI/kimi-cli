/**
 * NotificationStack.tsx — Transient toast notifications
 * Auto-dismisses after a configurable duration (default 4s).
 * Renders above the input area.
 */

import React, { useEffect, useState } from "react";
import { Box, Text } from "ink";

export interface Toast {
	id: string;
	title: string;
	body: string;
	severity?: "info" | "warning" | "error";
	duration?: number; // milliseconds, 0 = no auto-dismiss
	position?: "left" | "right"; // toolbar position, default "left"
	topic?: string; // for deduplication — new toast with same topic replaces old
	createdAt: number; // timestamp for expiry tracking
}

interface NotificationStackProps {
	toasts: Toast[];
	onDismiss: (id: string) => void;
}

const COLORS: Record<string, string> = {
	info: "#4a90e2", // Blue
	warning: "#f5a623", // Orange
	error: "#d0021b", // Red
};

export function NotificationStack({
	toasts,
	onDismiss,
}: NotificationStackProps) {
	if (toasts.length === 0) {
		return null;
	}

	return (
		<Box flexDirection="column">
			{toasts.map((toast) => (
				<ToastNotification
					key={toast.id}
					toast={toast}
					onDismiss={() => onDismiss(toast.id)}
				/>
			))}
		</Box>
	);
}

interface ToastNotificationProps {
	toast: Toast;
	onDismiss: () => void;
}

function ToastNotification({ toast, onDismiss }: ToastNotificationProps) {
	const severity = toast.severity || "info";
	const color = COLORS[severity];
	const duration = toast.duration ?? 4000;

	// Auto-dismiss after duration
	useEffect(() => {
		if (duration > 0) {
			const timer = setTimeout(onDismiss, duration);
			return () => clearTimeout(timer);
		}
	}, [duration, onDismiss]);

	const fullMessage = toast.title + (toast.body ? `: ${toast.body}` : "");

	return (
		<Box marginBottom={0}>
			<Text color={color} bold>
				{`[${severity.toUpperCase()}] `}
			</Text>
			<Text>{fullMessage}</Text>
		</Box>
	);
}
