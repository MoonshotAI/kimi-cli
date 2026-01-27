import { useCallback, useEffect, useMemo, useState, type ReactElement } from "react";
import { toast } from "sonner";
import { Settings2, RefreshCcw, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useConfigToml } from "@/hooks/useConfigToml";
import { dispatchGlobalConfigChanged } from "./events";
import {
  getSavedFontPreference,
  saveFontPreference,
  type FontPreference,
} from "./font-preference";

type SettingsDialogProps = {
  className?: string;
};

const FONT_OPTIONS: Array<{ value: FontPreference; label: string }> = [
  { value: "iosevka", label: "Iosevka" },
  { value: "system", label: "System Mono" },
];

export function SettingsDialog({ className }: SettingsDialogProps): ReactElement {
  const [open, setOpen] = useState(false);

  const { configToml, isLoading, isSaving, error, refresh, save } = useConfigToml();
  const [draftToml, setDraftToml] = useState("");

  const [restartRunningSessions, setRestartRunningSessions] = useState(true);
  const [forceRestartBusySessions, setForceRestartBusySessions] = useState(false);

  const [font, setFont] = useState<FontPreference>(() => getSavedFontPreference() ?? "iosevka");

  useEffect(() => {
    if (!open) {
      return;
    }
    refresh();
  }, [open, refresh]);

  useEffect(() => {
    if (!configToml) {
      return;
    }
    setDraftToml(configToml.toml);
  }, [configToml]);

  const hasUnsavedChanges = useMemo(() => {
    if (!configToml) {
      return false;
    }
    return draftToml !== configToml.toml;
  }, [configToml, draftToml]);

  const handleFontChange = useCallback((value: string) => {
    if (value !== "iosevka" && value !== "system") {
      return;
    }
    setFont(value);
    saveFontPreference(value);
    toast.success("Font updated", { description: "Applied immediately." });
  }, []);

  const handleReloadToml = useCallback(async () => {
    await refresh();
    toast.message("Reloaded", { description: "Loaded latest config.toml from disk." });
  }, [refresh]);

  const handleSaveToml = useCallback(async () => {
    try {
      const resp = await save({
        toml: draftToml,
        restartRunningSessions,
        forceRestartBusySessions,
      });

      dispatchGlobalConfigChanged();

      const restarted = resp.restartedSessionIds ?? [];
      const skippedBusy = resp.skippedBusySessionIds ?? [];

      toast.success("Saved config.toml", {
        description:
          restarted.length > 0
            ? `Restarted ${restarted.length} running session(s).`
            : undefined,
      });

      if (skippedBusy.length > 0) {
        toast.message("Some sessions were skipped (busy)", {
          description: `Skipped ${skippedBusy.length} busy session(s).`,
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to save config.toml";
      toast.error("Save failed", { description: message });
    }
  }, [draftToml, forceRestartBusySessions, restartRunningSessions, save]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <DialogTrigger asChild>
            <Button
              aria-label="Open settings"
              className={cn(
                "size-9 p-0 text-foreground hover:text-foreground dark:hover:text-foreground hover:bg-accent/20 dark:hover:bg-accent/20",
                className,
              )}
              size="icon"
              variant="outline"
            >
              <Settings2 className="size-4" />
            </Button>
          </DialogTrigger>
        </TooltipTrigger>
        <TooltipContent side="top">Settings</TooltipContent>
      </Tooltip>

      <DialogContent className="sm:max-w-3xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
        </DialogHeader>

        <div className="grid gap-6">
          <section className="grid gap-2">
            <div className="text-sm font-medium">Font</div>
            <div className="flex items-center gap-2">
              <Select value={font} onValueChange={handleFontChange}>
                <SelectTrigger className="w-[220px]">
                  <SelectValue placeholder="Select font..." />
                </SelectTrigger>
                <SelectContent>
                  {FONT_OPTIONS.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </section>

          <section className="grid gap-2">
            <div className="flex items-center justify-between gap-2">
              <div className="text-sm font-medium">Config.toml</div>
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={handleReloadToml}
                  disabled={isLoading || isSaving}
                >
                  <RefreshCcw className="mr-2 size-4" />
                  Reload
                </Button>
                <Button
                  type="button"
                  size="sm"
                  onClick={handleSaveToml}
                  disabled={isLoading || isSaving || !hasUnsavedChanges}
                >
                  <Save className="mr-2 size-4" />
                  Save
                </Button>
              </div>
            </div>

            <div className="text-xs text-muted-foreground font-mono">
              {configToml?.path ?? (isLoading ? "Loading..." : "")}
            </div>

            <Textarea
              value={draftToml}
              onChange={(e) => setDraftToml(e.target.value)}
              className="font-mono text-xs min-h-[320px]"
              placeholder={isLoading ? "Loading..." : "config.toml"}
              disabled={isLoading || isSaving}
              spellCheck={false}
              autoCorrect="off"
              autoCapitalize="off"
            />

            <div className="flex flex-wrap items-center gap-4">
              <div className="flex items-center gap-2">
                <Switch
                  checked={restartRunningSessions}
                  onCheckedChange={setRestartRunningSessions}
                  disabled={isSaving}
                  aria-label="Restart running sessions"
                />
                <span className="text-sm">Restart running sessions</span>
              </div>
              <div className="flex items-center gap-2">
                <Switch
                  checked={forceRestartBusySessions}
                  onCheckedChange={setForceRestartBusySessions}
                  disabled={!restartRunningSessions || isSaving}
                  aria-label="Force restart busy sessions"
                />
                <span className="text-sm">Force restart busy sessions</span>
              </div>
              <div className="text-xs text-muted-foreground">
                Busy restarts may interrupt an in-flight prompt.
              </div>
            </div>

            {error ? <div className="text-sm text-destructive">{error}</div> : null}
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}
