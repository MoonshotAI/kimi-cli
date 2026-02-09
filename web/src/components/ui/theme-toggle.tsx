import { MoonIcon, SunIcon } from "lucide-react";

import { useTheme } from "@/hooks/use-theme";
import { cn } from "@/lib/utils";

import { Button } from "./button";

type ThemeToggleProps = {
  className?: string;
};

export function ThemeToggle({ className }: ThemeToggleProps) {
  const { theme, toggleThemeWithTransition } = useTheme();
  const isDark = theme === "dark";

  return (
    <Button
      aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
      className={cn(
        "size-9 p-0 text-foreground hover:text-foreground dark:hover:text-foreground hover:bg-accent/20 dark:hover:bg-accent/20",
        "cursor-pointer",
        className,
      )}
      onClick={(e) => {
        toggleThemeWithTransition(e);
      }}
      size="icon"
      variant="outline"
    >
      {isDark ? (
        <SunIcon className="size-4" />
      ) : (
        <MoonIcon className="size-4" />
      )}
    </Button>
  );
}
