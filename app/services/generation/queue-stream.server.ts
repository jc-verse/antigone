import { requireOwnerSession } from "../auth/auth.server";
import { listJobs, subscribeQueue } from "./generation-store.server";
import { generationModels } from "./generation-models.server";

export function streamQueue(request: Request): Response {
  const encoder = new TextEncoder();
  let cleanup = (): void => {};
  let flush = (): Promise<void> | undefined => undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let pending = true;
      let flushing: Promise<void> | undefined = undefined;
      let unsubscribe = (): void => {};
      let heartbeat: ReturnType<typeof setInterval> | undefined = undefined;
      cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        unsubscribe();
        request.signal.removeEventListener("abort", close);
      };
      function close(): void {
        if (closed) return;
        cleanup();
        controller.close();
      }
      async function authorize(): Promise<boolean> {
        try {
          await requireOwnerSession(request);
          return !closed;
        } catch {
          if (!closed) {
            controller.enqueue(
              encoder.encode("event: auth-required\ndata: null\n\n"),
            );
            close();
          }
          return false;
        }
      }
      // A slow reader gets the newest full snapshot when it can accept data.
      // Reconnecting starts with a snapshot, without needing event replay.
      flush = () => {
        if (
          closed ||
          flushing ||
          !pending ||
          (controller.desiredSize ?? 0) <= 0
        )
          return flushing;
        flushing = authorize()
          .then((authorized) => {
            if (!authorized || closed) return;
            controller.enqueue(
              encoder.encode(
                `event: models\ndata: ${JSON.stringify(generationModels())}\n\n`,
              ),
            );
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify(listJobs())}\n\n`),
            );
            pending = false;
          })
          .catch(() => {
            close();
          })
          .finally(() => {
            flushing = undefined;
          });
        return flushing;
      };
      request.signal.addEventListener("abort", close, { once: true });
      if (request.signal.aborted) {
        close();
        return;
      }
      unsubscribe = subscribeQueue(() => {
        pending = true;
        void flush();
      });
      async function sendHeartbeat(): Promise<void> {
        try {
          if (!(await authorize())) return;
          if ((controller.desiredSize ?? 0) > 0)
            controller.enqueue(encoder.encode(": heartbeat\n\n"));
        } catch {
          close();
        }
      }
      heartbeat = setInterval(() => {
        void sendHeartbeat();
      }, 15000);
      void flush();
    },
    pull() {
      return flush();
    },
    cancel() {
      cleanup();
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "private, no-store",
      "X-Accel-Buffering": "no",
    },
  });
}
