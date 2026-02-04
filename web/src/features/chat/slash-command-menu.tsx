import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";
import { TerminalSquareIcon } from "lucide-react";
import type { SlashCommandOption } from "./useSlashCommands";

type SlashCommandMenuProps = {
  open: boolean;
  query: string;
  options: SlashCommandOption[];
  activeIndex: number;
  onSelect: (option: SlashCommandOption) => void;
  onHover: (index: number) => void;
};

export const SlashCommandMenu = ({
  open,
  query,
  options,
  activeIndex,
  onSelect,
  onHover,
}: SlashCommandMenuProps) => {
  const activeItemRef = useRef<HTMLButtonElement | null>(null);

  // Scroll active item into view when activeIndex changes
  useEffect(() => {
    if (open && activeItemRef.current) {
      activeItemRef.current.scrollIntoView({
        block: "nearest",
        behavior: "smooth",
      });
    }
  }, [open, activeIndex]);

  if (!open) {
    return null;
  }

  return (
    <div className="absolute left-0 right-0 bottom-[calc(100%+0.75rem)] z-30">
      <div className="rounded-xl border border-border/80 bg-popover/95 p-2 px-1 shadow-xl backdrop-blur supports-backdrop-filter:bg-popover/80">
        {options.length > 0 ? (
          <>
            <div className="px-3 pb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              Slash Commands
            </div>
            <div className="max-h-80 overflow-y-auto px-1 [-webkit-overflow-scrolling:touch]">
              {options.map((option, index) => {
                const isActive = index === activeIndex;
                return (
                  <button
                    key={option.id}
                    ref={isActive ? activeItemRef : null}
                    type="button"
                    className={cn(
                      "flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-sm transition-colors my-0.5",
                      isActive
                        ? "bg-primary/10 text-foreground ring-1 ring-primary/30"
                        : "hover:bg-muted",
                    )}
                    onMouseDown={(event) => {
                      event.preventDefault();
                      onSelect(option);
                    }}
                    onMouseEnter={() => onHover(index)}
                  >
                    <TerminalSquareIcon className="size-3.5 shrink-0 text-muted-foreground" />
                    <span className="truncate">
                      <span className="font-medium text-primary">/{option.name}</span>
                      {option.aliases.length > 0 && (
                        <span className="ml-1.5 text-xs text-muted-foreground/70">
                          ({option.aliases.join(", ")})
                        </span>
                      )}
                      <span className="ml-2 text-xs text-muted-foreground">
                        {option.description}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          </>
        ) : (
          <div className="px-3 py-2 text-sm text-muted-foreground">
            {query
              ? `No commands match "/${query}".`
              : "No commands available."}
          </div>
        )}
      </div>
    </div>
  );
};
