import { kimiCliVersion } from "@/lib/version";
import { cn } from "@/lib/utils";

type KimiCliBrandProps = {
  className?: string;
  size?: "sm" | "md";
  showVersion?: boolean;
};

export function KimiCliBrand({
  className,
  size = "md",
  showVersion = true,
}: KimiCliBrandProps) {
  const textSizeClass = size === "sm" ? "text-base" : "text-lg";
  const versionPadding = size === "sm" ? "text-xs" : "text-sm";
  const logoSize = size === "sm" ? "size-6" : "size-7";

  return (
    <div className={cn("flex items-center gap-2", className)}>
      <img src="/logo.png" alt="Kimi" className={logoSize} />
      <span className={cn(textSizeClass, "font-semibold text-foreground")}>
        Kimi Code
      </span>
      {showVersion && (
        <span
          className={cn("text-muted-foreground font-medium", versionPadding)}
        >
          v{kimiCliVersion}
        </span>
      )}
    </div>
  );
}
