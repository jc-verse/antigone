import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { eq } from "drizzle-orm";
import {
  requireOwnerSession,
  requireSameOrigin,
} from "../../services/auth/auth.server";

import {
  teardownRunpod,
  safeSetupError,
  setupCredentials,
  setupRunpod,
  type SetupState,
} from "../../services/runpod/runpod_provisioner";
import {
  modelDiskGb,
  modelIds,
  type ModelId,
} from "../../services/generation/models";
import { db } from "../../services/db/db.server";
import { runpodSetup } from "../../services/db/schema";
import { notifyQueue } from "../../services/generation/generation-store.server";

export { default } from "./RunpodConfig";

let running: Promise<void> | null = null;
let cancellation: AbortController | null = null;
let tearingDown: Promise<void> | null = null;

function read(): SetupState | null {
  const row = db.select().from(runpodSetup).where(eq(runpodSetup.id, 1)).get();
  return row ? (JSON.parse(row.state) as SetupState) : null;
}
function save(state: SetupState): void {
  const serialized = JSON.stringify(state);
  db.insert(runpodSetup)
    .values({ id: 1, state: serialized })
    .onConflictDoUpdate({ target: runpodSetup.id, set: { state: serialized } })
    .run();
  notifyQueue();
}

function clear(): void {
  db.delete(runpodSetup).where(eq(runpodSetup.id, 1)).run();
  notifyQueue();
}

function run(state: SetupState): void {
  if (running) return;
  cancellation = new AbortController();
  running = setupRunpod(
    state,
    (next) => {
      const current = read();
      if (current?.id !== next.id) return;
      save(
        current.status === "tearing_down"
          ? { ...next, status: current.status, message: current.message }
          : next,
      );
    },
    cancellation.signal,
  ).finally(() => {
    running = null;
  });
}
export interface SetupResponse {
  configured: boolean;
  job: SetupState | null;
}
function setupStatus(): SetupResponse {
  const job = read();
  if (job?.status === "tearing_down") runTeardown();
  const configured = Boolean(
    process.env.RUNPOD_API_KEY?.trim() && process.env.CIVITAI_KEY?.trim(),
  );
  if (
    configured &&
    job &&
    ["starting", "creating", "waiting", "checking"].includes(job.status)
  )
    run(job);
  return { configured, job };
}
let starting: Promise<SetupResponse> | null = null;
function startSetup(models: ModelId[]): Promise<SetupResponse> {
  starting ??= Promise.resolve()
    .then(() => start(models))
    .finally(() => {
      starting = null;
    });
  return starting;
}
function start(models: ModelId[]): SetupResponse {
  const previous = read();
  if (
    tearingDown ||
    previous?.status === "tearing_down" ||
    previous?.status === "teardown_error"
  )
    return setupStatus();
  setupCredentials();
  if (
    previous &&
    (running ||
      previous.status === "ready" ||
      previous.podId ||
      previous.uncertain ||
      ["starting", "creating", "waiting", "checking"].includes(previous.status))
  ) {
    if (!running) {
      if (previous.uncertain && !previous.podId) {
        previous.status = "creating";
      } else if (previous.podId) {
        previous.status = "checking";
        previous.message = "Checking ComfyUI availability…";
      }
      save(previous);
      run(previous);
    }
    return { configured: true, job: previous };
  }
  const id = crypto.randomUUID();
  const job: SetupState = {
    diskGb: modelDiskGb(models),
    models: [...models],
    id,
    name: `antigone-${id}`,
    status: "starting",
    message: "Starting Runpod setup…",
    podId: null,
    gpu: null,
    url: null,
    uncertain: false,
    createdAt: Date.now(),
  };
  save(job);
  run(job);
  return { configured: true, job };
}

function runTeardown(): void {
  if (tearingDown) return;
  cancellation?.abort();
  tearingDown = (async () => {
    // Let any in-flight create request finish so its pod ID is retained.
    await running;
    const job = read();
    if (!job || job.status !== "tearing_down") return;
    try {
      await teardownRunpod(job);
      clear();
    } catch (error) {
      save({
        ...job,
        status: "teardown_error",
        message: safeSetupError(error),
      });
    }
  })().finally(() => {
    tearingDown = null;
  });
}

async function teardownSetup(
  expectedId: string | null,
): Promise<SetupResponse> {
  await starting;
  const job = read();
  if (!job) return setupStatus();
  if (job.id !== expectedId)
    throw Error("The recorded pod changed. Refresh before tearing it down.");
  if (!process.env.RUNPOD_API_KEY?.trim())
    throw Error("Set RUNPOD_API_KEY in the local .env file first.");
  save({
    ...job,
    uncertain: job.uncertain || job.status === "creating",
    status: "tearing_down",
    message: "Terminating the pod and deleting its container storage…",
  });
  runTeardown();
  return setupStatus();
}

export async function loader({
  request,
}: LoaderFunctionArgs): Promise<Response> {
  await requireOwnerSession(request);
  return Response.json(setupStatus(), {
    headers: { "Cache-Control": "no-store" },
  });
}
export async function action({
  request,
}: ActionFunctionArgs): Promise<Response> {
  await requireOwnerSession(request);
  requireSameOrigin(request);
  if (request.method !== "POST" && request.method !== "DELETE")
    throw Response.json({ detail: "Method not allowed" }, { status: 405 });
  let models: ModelId[] = [];
  if (request.method === "POST") {
    const form = await request.formData().catch(() => {
      throw Response.json({ detail: "Invalid setup form" }, { status: 400 });
    });
    const selected = form.getAll("models");
    if (
      !selected.length ||
      selected.some(
        (id) =>
          typeof id !== "string" || !modelIds.some((known) => known === id),
      )
    ) {
      throw Response.json(
        { detail: "Choose at least one supported model" },
        { status: 400 },
      );
    }
    models = [...new Set(selected)] as ModelId[];
  }
  try {
    return Response.json(
      request.method === "DELETE"
        ? await teardownSetup(new URL(request.url).searchParams.get("jobId"))
        : await startSetup(models),
      { status: 202, headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return Response.json({ detail: safeSetupError(error) }, { status: 503 });
  }
}
