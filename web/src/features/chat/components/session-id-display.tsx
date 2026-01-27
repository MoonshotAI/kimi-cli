import type { ReactElement } from "react";

type SessionIdDisplayProps = {
  sessionId: string;
};

export function SessionIdDisplay({
  sessionId,
}: SessionIdDisplayProps): ReactElement {
  const copyToClipboard = async () => {
    try {
      await navigator.clipboard.writeText(sessionId);
    } catch (error) {
      console.error("Failed to copy session ID:", error);
    }
  };

  return (
    <button
      type="button"
      className="cursor-pointer rounded-md bg-background/70 px-2 py-1 font-mono text-[11px] text-muted-foreground shadow-xs ring-1 ring-border backdrop-blur hover:text-foreground"
      onClick={copyToClipboard}
      title={sessionId}
      aria-label="Copy session id"
    >
      {sessionId}
    </button>
  );
}
