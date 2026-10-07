import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import express from "express";
import { createRequestHandler } from "@remix-run/express";
import type { ServerBuild } from "@remix-run/node";

declare global {
  namespace Express {
    interface Locals {
      nonce: string;
    }
  }
}

async function startServer(root: URL): Promise<void> {
  const production = process.env.NODE_ENV === "production";
  const app = express();
  const httpServer = createServer(app);
  const viteServer = production
    ? null
    : await import("vite").then((vite) =>
        vite.createServer({
          root: fileURLToPath(root),
          server: {
            middlewareMode: true,
            hmr: { server: httpServer },
            watch: { usePolling: true, interval: 250 },
          },
        }),
      );

  app.disable("x-powered-by");
  app.set("trust proxy", false);

  app.use((req, res, next) => {
    delete req.headers["x-forwarded-host"];
    delete req.headers["x-forwarded-proto"];
    delete req.headers["x-forwarded-for"];
    req.headers["x-antigone-client-ip"] =
      req.socket.remoteAddress ?? "127.0.0.1";
    res.locals.nonce = randomBytes(24).toString("base64");
    res.set({
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy": `default-src 'self'; script-src 'self' 'nonce-${res.locals.nonce}'; style-src 'self'${production ? "" : " 'unsafe-inline'"}; img-src 'self' blob: data:; connect-src 'self'${production ? "" : " ws: wss:"}; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`,
    });
    next();
  });

  if (viteServer) {
    app.use(viteServer.middlewares);
  } else {
    app.use(
      "/assets",
      express.static(new URL("./build/client/assets", root).pathname, {
        immutable: true,
        maxAge: "1y",
      }),
    );
  }

  const handleRequest = createRequestHandler({
    build: viteServer
      ? () =>
          viteServer.ssrLoadModule(
            "virtual:remix/server-build",
          ) as Promise<ServerBuild>
      : ((await import(
          new URL("./build/server/index.js", root).href
        )) as ServerBuild),
    getLoadContext: (_req, res) => ({ nonce: res.locals.nonce }),
  });

  app.all("*", (req, res, next) => {
    res.set("Cache-Control", "no-store");
    void handleRequest(req, res, next).catch(next);
  });

  httpServer.listen(4410, "0.0.0.0", () =>
    console.log("Antigone server ready"),
  );
}

await startServer(new URL("./", import.meta.url));
