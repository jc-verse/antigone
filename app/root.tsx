import type { ReactElement } from "react";
import { Links, Meta, Outlet, Scripts, useLoaderData } from "@remix-run/react";
import type { LoaderFunctionArgs, MetaFunction } from "@remix-run/node";

import "./global.css";

import AppHeader from "./ui/layout/AppHeader";
import { ColorModeProvider } from "./ui/color-mode/ColorModeProvider";
import { ColorModeScript } from "./ui/color-mode/ColorModeScript";

export const loader = ({ context }: LoaderFunctionArgs) => ({
  nonce: context.nonce,
});

export const meta: MetaFunction = () => [{ title: "Antigone" }];

export default function App(): ReactElement {
  const { nonce } = useLoaderData<typeof loader>();

  return (
    <html lang="en-US" suppressHydrationWarning>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <ColorModeScript nonce={nonce} />
        <Meta />
        <Links />
      </head>
      <body>
        <ColorModeProvider>
          <AppHeader />
          <Outlet />
        </ColorModeProvider>
        <Scripts nonce={nonce} />
      </body>
    </html>
  );
}

export { RootErrorBoundary as ErrorBoundary } from "./RootErrorBoundary";
