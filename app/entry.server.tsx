import { PassThrough } from "node:stream";
import { createReadableStreamFromReadable, type AppLoadContext, type EntryContext  } from "@remix-run/node";
import { renderToPipeableStream } from "react-dom/server";
import { RemixServer } from "@remix-run/react";

const ABORT_DELAY = 5_000;

export default function handleRequest(
  request: Request,
  status: number,
  headers: Headers,
  context: EntryContext,
  loadContext: AppLoadContext,
): Promise<Response> {
  const { nonce } = loadContext;
  return new Promise((resolve, reject) => {
    let responseStatus = status;
    const body = new PassThrough();
    const { pipe, abort } = renderToPipeableStream(
      <RemixServer
        context={context}
        url={request.url}
        nonce={nonce}
        abortDelay={ABORT_DELAY}
      />,
      {
        nonce,
        onAllReady() {
          // eslint-disable-next-line no-use-before-define
          clearTimeout(timeout);
          headers.set("Content-Type", "text/html; charset=utf-8");
          resolve(
            new Response(createReadableStreamFromReadable(body), {
              status: responseStatus,
              headers,
            }),
          );
          pipe(body);
        },
        onShellError(error: unknown) {
          cleanup();
          body.destroy();
          reject(error);
        },
        onError(error: unknown) {
          responseStatus = 500;
          console.error(error);
        },
      },
    );
    const timeout = setTimeout(abort, ABORT_DELAY);
    function cancel(): void {
      abort();
      body.destroy();
      cleanup();
      reject(request.signal.reason);
    }
    function cleanup(): void {
      clearTimeout(timeout);
      request.signal.removeEventListener("abort", cancel);
    }
    body.once("close", cleanup);
    request.signal.addEventListener("abort", cancel, { once: true });
    if (request.signal.aborted) cancel();
  });
}
