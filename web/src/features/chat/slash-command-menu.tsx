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
      <div className="rounded-xl border border-border/80 bg-popover/95 p-2 shadow-xl backdrop-blur supports-backdrop-filter:bg-popover/80">
        <div className="max-h-64 overflow-y-auto [-webkit-overflow-scrolling:touch]">
          {options.length > 0 ? (
            <div className="py-1">
              <div className="px-3 pb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                Slash Commands
              </div>
              <div className="space-y-1">
                {options.map((option, index) => {
                  const isActive = index === activeIndex;
                  return (
                    <button
                      key={option.id}
                      ref={isActive ? activeItemRef : null}
                      type="button"
                      className={cn(
                        "flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm transition-colors",
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
                      <span className="rounded-md bg-muted/70 p-1 text-muted-foreground">
                        <TerminalSquareIcon className="size-4" />
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-medium">
                          <span className="text-primary">/{option.name}</span>
                          {option.aliases.length > 0 && (
                            <span className="ml-2 text-xs text-muted-foreground">
                              (aliases: {option.aliases.join(", ")})
                            </span>
                          )}
                        </p>
                        <p className="truncate text-xs text-muted-foreground">
                          {option.description}
                        </p>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          ) : (
            <div className="px-3 py-2 text-sm text-muted-foreground">
              {query
                ? `No commands match "/${query}".`
                : "No commands available."}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
