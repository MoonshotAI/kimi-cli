import { create } from "zustand";

type ToolEventsState = {
  /** Files written during the current session/turn */
  newFiles: string[];

  /** Add a file path when WriteFile completes successfully */
  addNewFile: (path: string) => void;
  /** Clear all new files (e.g., when opening files panel or starting new turn) */
  clearNewFiles: () => void;
};

export const useToolEventsStore = create<ToolEventsState>((set) => ({
  newFiles: [],
  addNewFile: (path) =>
    set((state) => ({
      newFiles: [...state.newFiles, path],
    })),
  clearNewFiles: () => set({ newFiles: [] }),
}));

/**
 * Handle tool result events and update store accordingly.
 * Call this from useSessionStream when a ToolResult event is received.
 *
 * @param isReplay - If true, this is a replay of history, skip notifications
 */
export function handleToolResult(
  toolName: string,
  toolArguments: string,
  isError: boolean,
  isReplay: boolean,
) {
  if (isError || isReplay) return;

  try {
    const args = JSON.parse(toolArguments);
    const { addNewFile } = useToolEventsStore.getState();

    // WriteFile: track by tool name (path/file_path is too generic)
    const lower = toolName.toLowerCase();
    if (
      lower.includes("writefile") ||
      lower.includes("write-file") ||
      lower.includes("write_file")
    ) {
      const filePath = args.path || args.file_path;
      if (filePath) {
        addNewFile(filePath);
      }
    }

    // Generic output parameters - these always indicate file creation
    if (args.output_file) addNewFile(args.output_file);
    if (args.output_path) addNewFile(args.output_path);
    if (args.download_dir) addNewFile(args.download_dir);
  } catch {
    // Ignore parse errors
  }
}
