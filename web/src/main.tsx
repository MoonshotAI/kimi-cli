import { initTauriRuntime } from "./lib/tauri";

const bootstrap = async (): Promise<void> => {
  try {
    await initTauriRuntime();
  } catch (error) {
    console.error("[main] tauri runtime init failed:", error);
  }

  if (import.meta.env.DEV) {
    try {
      const { scan } = await import("react-scan");
      scan({ enabled: true });
    } catch {
      // react-scan not available, skip
    }
  }

  await import("./bootstrap");
};

bootstrap().catch((error: unknown) => {
  console.error("[main] bootstrap failed:", error);
});
