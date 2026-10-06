import type { ReactElement } from "react";
import { Links, useRouteError, isRouteErrorResponse } from "@remix-run/react";
import styles from "./RootErrorBoundary.module.css";

export function RootErrorBoundary(): ReactElement {
  const error = useRouteError();

  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Error · Antigone</title>
        <Links />
      </head>
      <body>
        <main className={styles.errorBoundary}>
          <h1>{isRouteErrorResponse(error) ? error.status : "Unavailable"}</h1>
          <a href="/">Return to home page</a>
        </main>
      </body>
    </html>
  );
}
