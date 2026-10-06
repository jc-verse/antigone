import { createContext } from "react";

export type ColorMode = "system" | "light" | "dark";
export interface ColorModeContextValue {
  mode: ColorMode;
  setMode: (mode: ColorMode) => void;
}
export const ColorModeContext = createContext<ColorModeContextValue | null>(null);
