import { memo, type ReactElement } from "react";
import { cn } from "@/lib/utils";

type SessionRunningIndicatorProps = {
  label?: string;
  className?: string;
};

export const SessionRunningIndicator = memo(
  function SessionRunningIndicatorComponent({
    label = "Session is running",
    className,
  }: SessionRunningIndicatorProps): ReactElement {
    return (
      <output
        aria-label={label}
        title={label}
        className={cn("session-running-indicator", className)}
      >
        <span className="session-running-core" aria-hidden="true" />
      </output>
    );
  },
);
