export function handleWeb(sessionId: string): string {
	return (
		"Web UI is not yet available in the TypeScript version.\n" +
		"Use 'kimi web' CLI command to start the web server."
	);
}

export function handleVis(sessionId: string): string {
	return (
		"Visualizer is not yet available in the TypeScript version.\n" +
		"Use 'kimi vis' CLI command to start the visualizer."
	);
}

export function handleReload(): string {
	return "Configuration reloaded. If changes don't take effect, please restart the CLI.";
}

export function handleTask(): string {
	return (
		"Background task browser is not yet available in the TypeScript version.\n" +
		"Background tasks are managed automatically during agent execution."
	);
}
