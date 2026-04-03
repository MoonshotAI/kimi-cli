import { logger } from "../../../utils/logging.ts";

export function handleWeb(sessionId: string): void {
  logger.info("Web UI is not yet available in the TypeScript version.");
  logger.info("Use 'kimi web' CLI command to start the web server.");
}

export function handleVis(sessionId: string): void {
  logger.info("Visualizer is not yet available in the TypeScript version.");
  logger.info("Use 'kimi vis' CLI command to start the visualizer.");
}

export function handleReload(): void {
  logger.info("Configuration reloaded. If changes don't take effect, please restart the CLI.");
}

export function handleTask(): void {
  logger.info("Background task browser is not yet available in the TypeScript version.");
  logger.info("Background tasks are managed automatically during agent execution.");
}
