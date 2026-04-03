/**
 * Session-related slash commands: /new, /sessions, /title
 */

import { Session, loadSessionState, saveSessionState } from "../../../session.ts";
import { logger } from "../../../utils/logging.ts";

export async function handleNew(session: Session): Promise<void> {
  const workDir = session.workDir;
  if (await session.isEmpty()) {
    await session.delete();
  }
  const newSession = await Session.create(workDir);
  logger.info(`New session created: ${newSession.id}. Please restart to switch.`);
}

export async function handleSessions(session: Session): Promise<void> {
  const sessions = await Session.list(session.workDir);
  if (sessions.length === 0) {
    logger.info("No sessions found.");
    return;
  }
  for (const s of sessions) {
    const current = s.id === session.id ? " (current)" : "";
    const timeAgo = formatRelativeTime(s.updatedAt);
    logger.info(`  ${s.title} (${s.id}) - ${timeAgo}${current}`);
  }
}

export async function handleTitle(session: Session, args: string): Promise<void> {
  if (!args.trim()) {
    logger.info(`Session title: ${session.title}`);
    return;
  }
  const newTitle = args.trim().slice(0, 200);
  const freshState = await loadSessionState(session.dir);
  freshState.custom_title = newTitle;
  freshState.title_generated = true;
  await saveSessionState(freshState, session.dir);
  session.state.custom_title = newTitle;
  session.title = newTitle;
  logger.info(`Session title set to: ${newTitle}`);
}

function formatRelativeTime(timestamp: number): string {
  if (!timestamp) return "unknown";
  const now = Date.now() / 1000;
  const diff = now - timestamp;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)} minutes ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} hours ago`;
  return `${Math.floor(diff / 86400)} days ago`;
}
