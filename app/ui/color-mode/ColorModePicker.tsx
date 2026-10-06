import { useContext, type ReactElement } from "react";
import { ColorModeContext } from "./ColorModeContext";

import styles from "./ColorModePicker.module.css";

const modes = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
] as const;

function ThemeIcon({
  mode,
}: {
  readonly mode: (typeof modes)[number]["value"];
}): ReactElement {
  return (
    <svg
      aria-hidden="true"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round">
      {mode === "system" ? (
        <>
          <rect x="3" y="4" width="18" height="13" rx="2" />
          <path d="M12 17v4m-4 0h8" />
        </>
      ) : mode === "light" ? (
        <>
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5" />
        </>
      ) : (
        <path d="M21 13a9 9 0 0 1-10-10 9 9 0 1 0 10 10Z" />
      )}
    </svg>
  );
}

export function ColorModePicker(): ReactElement {
  const colorMode = useContext(ColorModeContext);
  if (!colorMode) throw new Error("ColorModePicker requires ColorModeProvider");

  return (
    <label className={styles.appearance}>
      <span>Appearance</span>
      <select
        className={styles.select}
        value={colorMode.mode}
        onChange={(event) => {
          const mode = modes.find(
            ({ value }) => value === event.currentTarget.value,
          );
          if (mode) colorMode.setMode(mode.value);
        }}>
        <button type="button">
          <ThemeIcon mode={colorMode.mode} />
          <span>
            {modes.find(({ value }) => value === colorMode.mode)!.label}
          </span>
        </button>
        {modes.map(({ value, label }) => (
          <option key={value} value={value}>
            <ThemeIcon mode={value} />
            <span>{label}</span>
          </option>
        ))}
      </select>
    </label>
  );
}
