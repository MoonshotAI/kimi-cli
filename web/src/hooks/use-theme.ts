import { useCallback, useEffect, useState } from "react";
import { flushSync } from "react-dom";

export type Theme = "light" | "dark";

const THEME_STORAGE_KEY = "kimi-theme";
const THEME_SWITCHING_ATTR = "data-theme-switching";
const THEME_SWITCH_DURATION_MS = 260;

type ThemeState = {
  theme: Theme;
  hasUserPreference: boolean;
};

export type ThemeTransitionEvent = Pick<MouseEvent, "clientX" | "clientY">;

type ThemeTransitionPoint = {
  x: number;
  y: number;
};

type UseThemeResult = {
  theme: Theme;
  setTheme: (next: Theme) => void;
  toggleTheme: () => void;
  toggleThemeWithTransition: (event?: ThemeTransitionEvent) => Promise<void>;
};

function getInitialTheme(): ThemeState {
  if (typeof window === "undefined") {
    return { theme: "light", hasUserPreference: false };
  }

  const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
  if (stored === "light" || stored === "dark") {
    return { theme: stored, hasUserPreference: true };
  }

  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  return { theme: prefersDark ? "dark" : "light", hasUserPreference: false };
}

function getTransitionPoint(
  event?: ThemeTransitionEvent,
): ThemeTransitionPoint {
  return {
    x: event?.clientX ?? window.innerWidth / 2,
    y: event?.clientY ?? window.innerHeight / 2,
  };
}

function getMaxRadius(point: ThemeTransitionPoint): number {
  const maxX = Math.max(point.x, window.innerWidth - point.x);
  const maxY = Math.max(point.y, window.innerHeight - point.y);
  return Math.hypot(maxX, maxY);
}

function startThemeSwitching(root: HTMLElement): void {
  root.setAttribute(THEME_SWITCHING_ATTR, "true");
}

function stopThemeSwitching(root: HTMLElement): void {
  root.removeAttribute(THEME_SWITCHING_ATTR);
}

function stopThemeSwitchingNextFrame(root: HTMLElement): void {
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      stopThemeSwitching(root);
    });
  });
}

export function useTheme(): UseThemeResult {
  const [state, setState] = useState<ThemeState>(() => getInitialTheme());
  const { theme, hasUserPreference } = state;

  // Apply theme to <html> and persist user preference
  useEffect(() => {
    if (typeof document === "undefined") return;
    const root = document.documentElement;
    root.classList.toggle("dark", theme === "dark");
    root.style.colorScheme = theme;

    if (hasUserPreference) {
      window.localStorage.setItem(THEME_STORAGE_KEY, theme);
    } else {
      window.localStorage.removeItem(THEME_STORAGE_KEY);
    }
  }, [theme, hasUserPreference]);

  // Sync with system preference only when the user has no explicit choice
  useEffect(() => {
    if (typeof window === "undefined") return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const handleChange = (event: MediaQueryListEvent) => {
      setState((prev) => {
        if (prev.hasUserPreference) return prev;
        return {
          theme: event.matches ? "dark" : "light",
          hasUserPreference: false,
        };
      });
    };

    media.addEventListener("change", handleChange);
    return () => media.removeEventListener("change", handleChange);
  }, []);

  const setTheme = useCallback((next: Theme) => {
    setState({ theme: next, hasUserPreference: true });
  }, []);

  const toggleTheme = useCallback(() => {
    setState((prev) => ({
      theme: prev.theme === "dark" ? "light" : "dark",
      hasUserPreference: true,
    }));
  }, []);

  const toggleThemeWithTransition = useCallback(
    async (event?: ThemeTransitionEvent) => {
      const canUseViewTransition =
        typeof document !== "undefined" &&
        typeof window !== "undefined" &&
        typeof document.startViewTransition === "function" &&
        !window.matchMedia("(prefers-reduced-motion: reduce)").matches;

      if (!canUseViewTransition) {
        if (typeof document !== "undefined") {
          const root = document.documentElement;
          startThemeSwitching(root);
          flushSync(() => {
            toggleTheme();
          });
          stopThemeSwitchingNextFrame(root);
        } else {
          toggleTheme();
        }
        return;
      }

      const root = document.documentElement;
      startThemeSwitching(root);

      const point = getTransitionPoint(
        event ? { clientX: event.clientX, clientY: event.clientY } : undefined,
      );
      const isDark = root.classList.contains("dark");
      const radius = getMaxRadius(point);
      const start = `circle(0px at ${point.x}px ${point.y}px)`;
      const end = `circle(${radius}px at ${point.x}px ${point.y}px)`;

      const transition = document.startViewTransition(() => {
        flushSync(() => {
          toggleTheme();
        });
      });

      await transition.ready;

      // Light→Dark: animate OLD (light) shrinking to reveal dark underneath
      // Dark→Light: animate NEW (light) expanding to cover dark
      const pseudoElement = isDark
        ? "::view-transition-new(root)"
        : "::view-transition-old(root)";

      const keyframes = isDark
        ? { clipPath: [start, end] }
        : { clipPath: [end, start] };

      root.animate(keyframes, {
        duration: THEME_SWITCH_DURATION_MS,
        easing: "cubic-bezier(0.22, 1, 0.36, 1)",
        fill: "both",
        pseudoElement,
      });

      transition.finished.finally(() => {
        stopThemeSwitching(root);
      });
    },
    [toggleTheme],
  );

  return { theme, setTheme, toggleTheme, toggleThemeWithTransition };
}
