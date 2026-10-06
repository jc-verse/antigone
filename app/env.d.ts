import "@remix-run/node";

declare module "@remix-run/node" {
  interface AppLoadContext {
    nonce: string;
  }
}
