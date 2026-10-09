#!/usr/bin/env bun
import setupCommand from "./runpod_bootstrap.py" with { type: "text" };
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  defaultModels,
  modelIds,
  modelRequirements,
  modelDiskGb,
  requiredModelFiles,
  type ModelId,
} from "../generation/models";

const api = "https://api.runpod.io/v2";
const gpuPreference = [
  "NVIDIA RTX 6000 Ada Generation",
  "NVIDIA L40",
  "NVIDIA A40",
  "NVIDIA L40S",
] as const;

interface DownloadProgress {
  name: string;
  status: "queued" | "downloading" | "validating" | "ready" | "error";
  bytes: number;
  total: number;
}
export interface SetupState {
  diskGb: number;
  models: ModelId[];
  id: string;
  name: string;
  status:
    | "starting"
    | "creating"
    | "waiting"
    | "checking"
    | "ready"
    | "error"
    | "tearing_down"
    | "teardown_error";
  message: string;
  podId: string | null;
  gpu: string | null;
  url: string | null;
  uncertain: boolean;
  createdAt: number;
  downloads?: DownloadProgress[];
  progressNotice?: string;
  comfyStage?: "queued" | "starting" | "checking" | "ready" | "error";
}
interface Pod {
  id: string;
  name: string;
  status: string;
  disk: number;
  mounts?: { persistent?: { size: number }; network?: unknown[] };
  gpu?: { id: string };
}
class RunpodError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
export function setupCredentials(): { runpodKey: string; civitaiKey: string } {
  const runpodKey = process.env.RUNPOD_API_KEY?.trim();
  const civitaiKey = process.env.CIVITAI_KEY?.trim();
  if (!runpodKey || !civitaiKey) {
    throw Error(
      "Set RUNPOD_API_KEY and CIVITAI_KEY in the local .env file before starting setup.",
    );
  }
  return { runpodKey, civitaiKey };
}
export function safeSetupError(error: unknown): string {
  let message = error instanceof Error ? error.message : "Runpod setup failed";
  for (const secret of [
    process.env.RUNPOD_API_KEY,
    process.env.CIVITAI_KEY,
    process.env.HF_TOKEN,
    process.env.GHCR_TOKEN,
    process.env.GHCR_TOKEN?.trim(),
  ])
    if (secret) message = message.replaceAll(secret, "[redacted]");

  return message.slice(0, 1000);
}
async function control<T>(
  path: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  const runpodKey = process.env.RUNPOD_API_KEY?.trim();
  if (!runpodKey)
    throw Error("Set RUNPOD_API_KEY in the local .env file first.");
  const response = await fetch(`${api}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${runpodKey}`,
      "User-Agent": "Mozilla/5.0",
      "Content-Type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(60000),
    redirect: "error",
  });
  if (!response.ok) {
    const problem = (await response.json().catch(() => ({}))) as {
      detail?: unknown;
    };
    throw new RunpodError(
      response.status,
      `Runpod (${response.status}): ${typeof problem.detail === "string" ? safeSetupError(new Error(problem.detail)) : response.statusText}`,
    );
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}
async function imageRegistry(): Promise<string | undefined> {
  const username = process.env.GHCR_USERNAME?.trim();
  const password = process.env.GHCR_TOKEN?.trim();
  if (!username && !password) return undefined;
  if (!username || !password) {
    throw Error(
      "For a private image, set both GHCR_USERNAME and GHCR_TOKEN in .env; leave both empty for a public image.",
    );
  }
  // Rotating the token preserves the credential record used by existing pods.
  const fingerprint = createHash("sha256")
    .update(`${username}\0${password}`)
    .digest("hex")
    .slice(0, 16);
  const name = `antigone-ghcr-${fingerprint}`;
  const { registries } = await control<{
    registries: { id: string; name: string }[];
  }>("/registries");
  const existing = registries.find((entry) => entry.name === name);
  if (existing) return existing.id;
  const registry = await control<{ id: string }>("/registries", "POST", {
    name,
    username,
    password,
  });
  if (!registry.id) throw Error("Runpod returned no registry credential ID.");
  return registry.id;
}
async function findCreatedPod(name: string): Promise<Pod | undefined> {
  let cursor: string | null = null;
  do {
    const page: { pods: Pod[]; pagination: { nextCursor: string | null } } =
      await control<{ pods: Pod[]; pagination: { nextCursor: string | null } }>(
        `/pods?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      );
    const found = page.pods.find((pod) => pod.name === name);
    if (found) return found;
    cursor = page.pagination.nextCursor;
  } while (cursor);
  return undefined;
}

export async function teardownRunpod(state: SetupState): Promise<void> {
  let id = state.podId;
  if (!id) {
    const found = await findCreatedPod(state.name);
    id = found?.id ?? null;
    if (!id && state.uncertain) {
      throw Error(
        `Pod creation has an unknown outcome. Check Runpod for ${state.name}, then retry teardown.`,
      );
    }
  }
  if (!id) return;
  try {
    await control<undefined>(`/pods/${encodeURIComponent(id)}`, "DELETE");
  } catch (error) {
    if (!(error instanceof RunpodError && error.status === 404)) throw error;
  }
}

function listed(data: unknown, node: string, field: string): unknown {
  const record = data as {
    [key: string]: { input?: { required?: { [key: string]: unknown[] } } };
  };
  return record[node]?.input?.required?.[field]?.[0];
}

async function watchDownloads(
  state: SetupState,
  update: (changes: Partial<SetupState>) => void,
  signal: AbortSignal,
): Promise<void> {
  const modelFiles = requiredModelFiles(state.models);
  let cursor = "";
  const aborted = (): boolean => signal.aborted;
  while (!aborted()) {
    try {
      const query = new URLSearchParams({
        source: "container",
        since: new Date(state.createdAt).toISOString(),
      });
      const response = await fetch(
        `${api}/pods/${encodeURIComponent(state.podId!)}/logs?${query}`,
        {
          headers: {
            Authorization: `Bearer ${process.env.RUNPOD_API_KEY?.trim() ?? ""}`,
            Accept: "text/event-stream",
            ...(cursor ? { "Last-Event-ID": cursor } : {}),
          },
          signal: AbortSignal.any([signal, AbortSignal.timeout(60000)]),
          redirect: "error",
        },
      );
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        throw Error("Log stream unavailable");
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      try {
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          buffer += decoder.decode(next.value, { stream: true });
          if (buffer.length > 4 * 1024 * 1024)
            throw Error("Oversized log frame");
          let boundary = /\r?\n\r?\n/u.exec(buffer);
          while (boundary) {
            const frame = buffer.slice(0, boundary.index);
            buffer = buffer.slice(boundary.index + boundary[0].length);
            const lines = frame.split(/\r?\n/u);
            const id = lines
              .find((line) => line.startsWith("id:"))
              ?.slice(3)
              .trim();
            const data = lines
              .filter((line) => line.startsWith("data:"))
              .map((line) => line.slice(5).trimStart())
              .join("\n");
            if (data) {
              let parsed: unknown = null;
              try {
                parsed = JSON.parse(data) as unknown;
              } catch {
                /* Ignore non-log frames. */
              }
              const entry = parsed as {
                source?: unknown;
                line?: unknown;
              } | null;
              if (
                entry?.source === "container" &&
                typeof entry.line === "string"
              ) {
                const comfyStage =
                  /ANTIGONE_COMFYUI (?<stage>starting|checking|ready|error)\b/u.exec(
                    entry.line,
                  )?.groups?.stage;
                if (comfyStage) {
                  update({
                    comfyStage: comfyStage as NonNullable<
                      SetupState["comfyStage"]
                    >,
                    progressNotice: "",
                  });
                }
                const match =
                  /ANTIGONE_DOWNLOAD (?<name>\S+) (?<status>downloading|validating|ready|error) (?<bytes>\d+) (?<total>\d+)/u.exec(
                    entry.line,
                  )?.groups;
                if (match && modelFiles.includes(match.name!)) {
                  const bytes = Number(match.bytes);
                  const total = Number(match.total);
                  if (
                    Number.isSafeInteger(bytes) &&
                    Number.isSafeInteger(total)
                  ) {
                    const download: DownloadProgress = {
                      name: match.name!,
                      status: match.status as DownloadProgress["status"],
                      bytes,
                      total,
                    };
                    update({
                      downloads: modelFiles.map((name) =>
                        name === download.name
                          ? download
                          : (state.downloads?.find(
                              (item) => item.name === name,
                            ) ?? {
                              name,
                              status: "queued",
                              bytes: 0,
                              total: 0,
                            }),
                      ),
                      progressNotice: "",
                    });
                  }
                }
              }
            }
            if (id) cursor = id;
            boundary = /\r?\n\r?\n/u.exec(buffer);
          }
        }
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
    } catch {
      if (!aborted()) {
        update({
          progressNotice:
            "Setup progress is reconnecting. Setup continues on the pod.",
        });
      }
    }
    if (!aborted()) await delay(3000, undefined, { signal }).catch(() => {});
  }
}

export async function setupRunpod(
  state: SetupState,
  save: (next: SetupState) => void,
  signal?: AbortSignal,
): Promise<void> {
  const models = state.models;
  const diskGb = modelDiskGb(models);
  const modelFiles = requiredModelFiles(models);
  const modelLabels = models
    .map((id) => modelRequirements[id].label)
    .join(", ");
  const checkOnly = state.status === "checking";
  const logController = new AbortController();
  let logs = Promise.resolve();
  const update = (changes: Partial<SetupState>): void => {
    Object.assign(state, changes);
    save(state);
  };
  try {
    if (checkOnly && !state.podId) throw Error("No pod is recorded to check.");
    const { civitaiKey } = setupCredentials();
    if (!state.podId && state.status === "creating") {
      const found = await findCreatedPod(state.name);
      if (!found) {
        update({ uncertain: true });
        throw Error(
          `Creation was interrupted. Check Runpod for ${state.name} before creating another pod.`,
        );
      }
      update({ podId: found.id, gpu: found.gpu?.id ?? null });
    }
    if (!state.podId) {
      const image =
        process.env.RUNPOD_IMAGE?.trim() ||
        "ghcr.io/jc-verse/antigone-comfyui:v0.38.0-1";
      update({ message: "Configuring image access…" });
      const registry = await imageRegistry();
      for (const gpu of gpuPreference) {
        signal?.throwIfAborted();
        update({
          status: "starting",
          gpu,
          message: `Checking ${gpu} availability…`,
        });
        const catalog = await control<{
          cudaVersions: { version: string; available: boolean }[];
        }>(
          `/catalog/gpus/${encodeURIComponent(gpu)}?include=AVAILABILITY&product=POD&cloud=SECURE`,
        );
        const allowedCudaVersions = catalog.cudaVersions
          .filter(
            ({ version, available }) =>
              available && Number(version.split(".")[0]) >= 13,
          )
          .map(({ version }) => version);
        if (!allowedCudaVersions.length) {
          update({
            status: "starting",
            message: `${gpu} has no available CUDA 13-compatible hosts.`,
          });
          continue;
        }
        update({
          status: "creating",
          gpu,
          diskGb,
          message: `Requesting ${gpu} with ${diskGb} GB disk…`,
        });
        try {
          const pod = await control<Pod>("/pods", "POST", {
            name: state.name,
            image,
            ...(registry ? { registry } : {}),
            gpu: { id: gpu, count: 1, allowedCudaVersions },
            disk: diskGb,
            mounts: {},
            cloud: "SECURE",
            ports: ["8188/http"],
            startSsh: false,
            startJupyter: false,
            entrypoint: ["python3", "-u", "-c"],
            cmd: [setupCommand],
            env: {
              ANTIGONE_MODELS: models.join(","),
              CIVITAI_KEY: civitaiKey,
              HF_TOKEN: process.env.HF_TOKEN?.trim() ?? "",
            },
          });
          if (!pod.id || !/^[\w-]+$/u.test(pod.id)) {
            update({ uncertain: true });
            throw Error(
              `Runpod returned no usable pod ID. Check Runpod for ${state.name}.`,
            );
          }
          update({
            podId: pod.id,
            uncertain: false,
            url: `https://${pod.id}-8188.proxy.runpod.net`,
            status: "waiting",
            message: `Pod created; starting ComfyUI and downloading ${modelLabels}…`,
          });
          if (
            pod.disk !== diskGb ||
            (pod.mounts?.persistent?.size ?? 0) > 0 ||
            (pod.mounts?.network?.length ?? 0) > 0
          ) {
            throw Error(
              "Runpod returned unexpected storage settings. Inspect the created pod before using it.",
            );
          }
          break;
        } catch (error) {
          if (
            !state.podId &&
            error instanceof RunpodError &&
            (error.status === 400 || error.status === 403)
          ) {
            update({ status: "starting", message: safeSetupError(error) });
            continue;
          }
          if (
            !state.podId &&
            (!(error instanceof RunpodError) || error.status >= 500)
          )
            update({ uncertain: true });
          throw error;
        }
      }
      if (!state.podId) {
        throw Error(
          `None of ${gpuPreference.join(", ")} could be provisioned. ${state.message}`,
        );
      }
    }
    const url = `https://${state.podId}-8188.proxy.runpod.net`;
    update({
      status: checkOnly ? "checking" : "waiting",
      comfyStage: checkOnly ? "checking" : (state.comfyStage ?? "queued"),
      url,
      message: checkOnly
        ? "Checking ComfyUI availability…"
        : `Waiting for ComfyUI and ${modelLabels}…`,
    });
    if (!state.downloads) {
      update({
        downloads: modelFiles.map((name) => ({
          name,
          status: "queued",
          bytes: 0,
          total: 0,
        })),
      });
    }
    logs = watchDownloads(
      state,
      update,
      signal
        ? AbortSignal.any([signal, logController.signal])
        : logController.signal,
    );
    const deadline = checkOnly
      ? Date.now() + 60000
      : state.createdAt + 120 * 60 * 1000;
    while (Date.now() < deadline) {
      signal?.throwIfAborted();
      if (!checkOnly && state.comfyStage === "error")
        throw Error(
          "ComfyUI bootstrap or startup failed. Inspect the pod logs.",
        );
      const failed = state.downloads?.find((item) => item.status === "error");
      if (
        failed &&
        !checkOnly &&
        state.downloads?.every(
          (item) => item.status === "ready" || item.status === "error",
        )
      ) {
        throw Error(
          `Download or validation failed for ${failed.name}. Inspect the pod logs.`,
        );
      }
      const pod = await control<Pod>(`/pods/${state.podId}`);
      if (["EXITED", "TERMINATED"].includes(pod.status)) {
        throw Error(
          `Pod is ${pod.status.toLowerCase()}. Inspect its logs in Runpod.`,
        );
      }
      const ready = await fetch(`${url}/object_info`, {
        headers: {
          "User-Agent": "Mozilla/5.0",
          Origin: url,
          Referer: `${url}/`,
        },
        signal: AbortSignal.timeout(15000),
        redirect: "error",
      })
        .then(async (response) => {
          if (!response.ok) {
            await response.body?.cancel();
            return false;
          }
          const data = (await response.json()) as unknown;
          if (!data || typeof data !== "object") return false;
          const nodes = data as { [name: string]: unknown };
          const has = (node: string, field: string, value: string): boolean => {
            const choices = listed(data, node, field);
            return Array.isArray(choices) && choices.includes(value);
          };
          return models.every((id) => {
            const model = modelRequirements[id];
            return (
              model.nodes.every((name) => Boolean(nodes[name])) &&
              has("CLIPLoader", "type", model.clipType) &&
              has("UNETLoader", "unet_name", model.unet) &&
              has("CLIPLoader", "clip_name", model.clip) &&
              has("VAELoader", "vae_name", model.vae) &&
              model.loras.every((name) =>
                has("LoraLoader", "lora_name", name),
              ) &&
              has("KSampler", "sampler_name", model.sampler) &&
              has("KSampler", "scheduler", model.scheduler)
            );
          });
        })
        .catch(() => false);
      if (ready) {
        update({
          status: "ready",
          comfyStage: "ready",
          message: "ComfyUI and models are ready.",
          progressNotice: "",
          downloads:
            state.downloads?.map((item) => ({ ...item, status: "ready" })) ??
            [],
        });
        return;
      }
      if (checkOnly) {
        throw Error(
          "Some dependency(s) is unavailable. Check the pod in Runpod, or try again shortly.",
        );
      }
      await delay(5000, undefined, { signal });
    }
    throw Error(
      "Setup timed out. The pod still exists; inspect its logs in Runpod.",
    );
  } catch (error) {
    update({ status: "error", message: safeSetupError(error) });
  } finally {
    logController.abort();
    await logs;
  }
}

if (import.meta.main) {
  const requested =
    process.env.ANTIGONE_MODELS?.split(",").map((model) => model.trim()) ??
    defaultModels;
  if (
    !requested.length ||
    requested.some((model) => !modelIds.some((known) => known === model))
  )
    throw Error("ANTIGONE_MODELS must contain noct-q, qwen-lora, or snofs");
  const models = [...new Set(requested)] as ModelId[];
  const id = crypto.randomUUID();
  const state: SetupState = {
    diskGb: modelDiskGb(models),
    models,
    id,
    name: `antigone-${id}`,
    status: "starting",
    message: "Starting…",
    podId: null,
    gpu: null,
    url: null,
    uncertain: false,
    createdAt: Date.now(),
  };
  void setupRunpod(state, (next) => console.error(next.message)).then(() => {
    if (state.podId) console.log(state.podId);
    if (state.status !== "ready") process.exitCode = 1;
  });
}
