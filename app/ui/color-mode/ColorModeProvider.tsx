import {
  useState,
  useEffect,
  useMemo,
  type ReactElement,
  type ReactNode,
} from "react";
import {
  ColorModeContext,
  type ColorMode,
  type ColorModeContextValue,
} from "./ColorModeContext";

export function ColorModeProvider({
  children,
}: {
  readonly children: ReactNode;
}): ReactElement {
  const [mode, setMode] = useState<ColorMode>("system");
  useEffect(() => {
    const saved = document.documentElement.dataset.colorMode;
    if (saved === "light" || saved === "dark") setMode(saved);
  }, []);
  const value = useMemo<ColorModeContextValue>(
    () => ({
      mode,
      setMode(next) {
        setMode(next);
        document.documentElement.dataset.colorMode = next;
        try {
          localStorage.setItem("antigone-color-mode", next);
        } catch {
          /* Keep the choice for this page. */
        }
      },
    }),
    [mode],
  );
  return (
    <ColorModeContext.Provider value={value}>
      {children}
    </ColorModeContext.Provider>
  );
}
