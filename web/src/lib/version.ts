declare const __KIMI_CLI_VERSION__: string | undefined;

export const kimiCliVersion =
  typeof __KIMI_CLI_VERSION__ !== "undefined" && __KIMI_CLI_VERSION__
    ? __KIMI_CLI_VERSION__
    : "dev";
