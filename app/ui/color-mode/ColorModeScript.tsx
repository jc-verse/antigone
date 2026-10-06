import type { ReactElement } from "react";

const colorModeScript = `try { const mode = localStorage.getItem("antigone-color-mode"); if (mode === "light" || mode === "dark") document.documentElement.dataset.colorMode = mode; } catch {}`;

export function ColorModeScript({
  nonce,
}: {
  readonly nonce: string;
}): ReactElement {
  // The fixed script uses the response's CSP nonce.
  return (
    <script
      nonce={nonce}
      suppressHydrationWarning
      // eslint-disable-next-line react/no-danger
      dangerouslySetInnerHTML={{ __html: colorModeScript }}
    />
  );
}
