import * as React from "react";
import * as SwitchPrimitive from "@radix-ui/react-switch";

import { cn } from "@/lib/utils";

// Track: 36×20 (h-5 w-9), padding 2px → inner 32×16
// Thumb: 16×16 (size-4), travel 16px (translate-x-4)
// Radix sets an inline `transform` on checked thumbs that conflicts with the
// CSS `translate` property; resetting it via `style` keeps a single source of
// positioning truth.
function Switch({
  className,
  ...props
}: React.ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        "peer inline-flex h-5 w-9 shrink-0 items-center rounded-full p-0.5 shadow-xs transition-all outline-none",
        "data-[state=checked]:bg-primary data-[state=unchecked]:bg-input dark:data-[state=unchecked]:bg-input/80",
        "focus-visible:ring-ring/50 focus-visible:ring-[3px]",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className={cn(
          "pointer-events-none block size-4 rounded-full ring-0",
          "bg-background dark:data-[state=unchecked]:bg-foreground dark:data-[state=checked]:bg-primary-foreground",
          "transition-[translate] duration-200 data-[state=checked]:translate-x-4 data-[state=unchecked]:translate-x-0",
        )}
        style={{ transform: "none" }}
      />
    </SwitchPrimitive.Root>
  );
}

export { Switch };
