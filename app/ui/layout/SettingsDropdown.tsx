import { useState, useEffect, useRef, useId, type ReactElement } from "react";
import { Link } from "@remix-run/react";
import { ColorModePicker } from "../color-mode/ColorModePicker";

import styles from "./SettingsDropdown.module.css";

export default function SettingsDropdown(): ReactElement {
  const id = useId();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsRef = useRef<HTMLDivElement>(null);
  const settingsButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!settingsOpen) return undefined;
    function dismiss(event: PointerEvent): void {
      if (!settingsRef.current?.contains(event.target as Node))
        setSettingsOpen(false);
    }
    function escape(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        setSettingsOpen(false);
        settingsButtonRef.current?.focus();
      }
    }
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", escape);
    };
  }, [settingsOpen]);

  return (
    <div className={styles.settings} ref={settingsRef}>
      <button
        type="button"
        ref={settingsButtonRef}
        className={styles.iconButton}
        aria-label="Settings"
        title="Settings"
        aria-expanded={settingsOpen}
        aria-controls={id}
        onClick={() => setSettingsOpen((open) => !open)}>
        <svg
          aria-hidden="true"
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round">
          <path d="m9 3-.5 2a8 8 0 0 0-2 1.2l-2-.6-2 3.4L4 10.5a8 8 0 0 0 0 3L2.5 15l2 3.4 2-.6a8 8 0 0 0 2 1.2l.5 2h6l.5-2a8 8 0 0 0 2-1.2l2 .6 2-3.4-1.5-1.5a8 8 0 0 0 0-3L21.5 9l-2-3.4-2 .6a8 8 0 0 0-2-1.2L15 3Z" />
          <circle cx="12" cy="12" r="3" />
        </svg>
      </button>
      <div id={id} className={styles.settingsDropdown} hidden={!settingsOpen}>
        <Link to="/auth/manage">Authentication</Link>
        <Link to="/runpod-config">Runpod</Link>
        <ColorModePicker />
      </div>
    </div>
  );
}
