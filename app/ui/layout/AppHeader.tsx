import type { ReactElement } from "react";
import { NavLink } from "@remix-run/react";
import SettingsDropdown from "./SettingsDropdown";

import styles from "./AppHeader.module.css";

export default function AppHeader(): ReactElement {
  return (
    <header className={styles.header}>
      <nav className={styles.navigation} aria-label="Antigone">
        <NavLink to="/" className={styles.brand!}>
          Antigone
        </NavLink>
        <NavLink to="/library">Library</NavLink>
      </nav>
      <SettingsDropdown />
    </header>
  );
}
