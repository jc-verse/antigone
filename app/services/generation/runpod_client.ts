#!/usr/bin/env bun
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { setTimeout as delay } from "node:timers/promises";

export interface ImageOptions {
  url: string;
  prompt: string;
  model?: "auto" | "noct-q" | "qwen-lora" | "snofs" | undefined;
  images?: readonly Blob[] | undefined;
  negative?: string | undefined;
  width?: number | undefined;
  height?: number | undefined;
  steps?: number | undefined;
  count?: number | undefined;
  cfg?: number | undefined;
  seed?: number | undefined;
}

interface ComfyImage {
  filename: string;
  subfolder?: string;
  type?: string;
}

interface SamplingProgress {
  value: number;
  max: number;
}

interface WorkflowNode {
  class_type: string;
  inputs: { [key: string]: unknown };
}

const kleinStages: { [key: string]: string } = {
  "4": "Loading SNOFS…",
  "12": "Loading text encoder…",
  "13": "Loading VAE…",
  "6": "Encoding prompt…",
  "7": "Encoding prompt…",
  "10": "Loading input image…",
  "14": "Scaling input image…",
  "11": "Encoding input image…",
  "15": "Attaching reference…",
  "5": "Preparing image…",
  "3": "Sampling…",
  "8": "Decoding image…",
  "9": "Saving image…",
};

const noctStages: { [key: string]: string } = {
  "4": "Loading Noct Q…",
  "12": "Loading text encoder…",
  "13": "Loading VAE…",
  "6": "Encoding prompt…",
  "10": "Loading input image…",
  "14": "Scaling input image…",
  "5": "Preparing image…",
  "3": "Sampling…",
  "8": "Decoding image…",
  "9": "Saving image…",
};

const qwenStages: { [key: string]: string } = {
  "4": "Loading Qwen 2.1…",
  "12": "Loading text encoder…",
  "13": "Loading VAE…",
  "16": "Applying anatomy LoRA…",
  "6": "Encoding prompt…",
  "10": "Loading input image…",
  "14": "Scaling input image…",
  "5": "Preparing image…",
  "3": "Sampling…",
  "8": "Decoding image…",
  "9": "Saving image…",
};

async function watchProgress(
  base: string,
  clientId: string,
  signal: AbortSignal,
  stages: { [key: string]: string },
  onStatus: (status: string) => void,
  onProgress: (progress: SamplingProgress | null) => void,
): Promise<{ setPrompt: (id: string) => void; close: () => void }> {
  const url = new URL(`${base}/ws`);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("clientId", clientId);
  // Bun supports handshake headers; the DOM constructor type does not.
  const Socket = WebSocket as unknown as new (
    address: string,
    options: Bun.WebSocketOptions,
  ) => WebSocket;
  const socket = new Socket(url.href, {
    headers: {
      "User-Agent": "Mozilla/5.0",
      Origin: new URL(base).origin,
      Referer: `${new URL(base).origin}/`,
    },
  });
  let promptId = "";
  let closed = false;
  const pending: string[] = [];
  function receive(raw: string): void {
    if (closed) return;
    if (!promptId) {
      if (pending.length < 64) pending.push(raw);
      return;
    }
    const parsed: unknown = (() => {
      try {
        return JSON.parse(raw) as unknown;
      } catch {
        return null;
      }
    })();
    if (!parsed || typeof parsed !== "object") return;
    const message = parsed as { type?: unknown; data?: unknown };
    if (!message.data || typeof message.data !== "object") return;
    const data = message.data as { [key: string]: unknown };
    if (data.prompt_id !== promptId) return;
    const { type } = message;
    if (
      type === "progress" &&
      data.node === "3" &&
      typeof data.value === "number" &&
      typeof data.max === "number" &&
      Number.isFinite(data.value) &&
      Number.isFinite(data.max) &&
      data.value >= 0 &&
      data.max > 0 &&
      data.value <= data.max
    ) {
      onProgress({ value: data.value, max: data.max });
    } else if (type === "executing") {
      if (typeof data.node === "string") {
        onProgress(null);
        onStatus(stages[data.node] ?? "Generating image…");
      }
    } else if (type === "execution_start") {
      onProgress(null);
      onStatus("Starting generation…");
    }
  }
  socket.addEventListener("message", (event) => {
    if (typeof event.data === "string") receive(event.data);
  });
  socket.addEventListener("close", () => {
    if (!closed && promptId && !signal.aborted) {
      onProgress(null);
      onStatus("Generating image… Live progress unavailable.");
    }
  });
  const close = (): void => {
    closed = true;
    signal.removeEventListener("abort", close);
    socket.close();
  };
  signal.addEventListener("abort", close, { once: true });
  if (signal.aborted) close();
  const handshake = new AbortController();
  const connected = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), 3000);
    const finish = (ready: boolean): void => {
      clearTimeout(timer);
      resolve(ready);
    };
    const listenerOptions = { once: true, signal: handshake.signal };
    socket.addEventListener("open", () => finish(true), listenerOptions);
    socket.addEventListener("error", () => finish(false), listenerOptions);
    socket.addEventListener("close", () => finish(false), listenerOptions);
    signal.addEventListener("abort", () => finish(false), listenerOptions);
    if (signal.aborted) finish(false);
  });
  handshake.abort();
  if (!connected) close();
  return {
    setPrompt(id) {
      promptId = id;
      for (const raw of pending) receive(raw);
      pending.length = 0;
    },
    close,
  };
}

class GPUOutOfMemoryError extends Error {}

function snofsWorkflow(
  options: ImageOptions,
  imageName: string | null,
  width: number,
  height: number,
): { [key: string]: WorkflowNode } {
  return {
    "4": {
      class_type: "UNETLoader",
      inputs: {
        unet_name: "snofs-klein-9b-base.safetensors",
        weight_dtype: "default",
      },
    },
    "12": {
      class_type: "CLIPLoader",
      inputs: { clip_name: "qwen_3_8b.safetensors", type: "flux2" },
    },
    "13": {
      class_type: "VAELoader",
      inputs: { vae_name: "flux2-vae.safetensors" },
    },
    "6": {
      class_type: "CLIPTextEncode",
      inputs: { text: options.prompt, clip: ["12", 0] },
    },
    "7": {
      class_type: "CLIPTextEncode",
      inputs: { text: options.negative ?? "", clip: ["12", 0] },
    },
    "5": {
      class_type: "EmptyFlux2LatentImage",
      inputs: { width, height, batch_size: options.count ?? 1 },
    },
    ...(imageName
      ? {
          "10": { class_type: "LoadImage", inputs: { image: imageName } },
          "14": {
            class_type: "ImageScaleToTotalPixels",
            inputs: {
              image: ["10", 0],
              upscale_method: "lanczos",
              megapixels: 1,
              resolution_steps: 16,
            },
          },
          "11": {
            class_type: "VAEEncode",
            inputs: { pixels: ["14", 0], vae: ["13", 0] },
          },
          "15": {
            class_type: "ReferenceLatent",
            inputs: { conditioning: ["6", 0], latent: ["11", 0] },
          },
        }
      : {}),
    "3": {
      class_type: "KSampler",
      inputs: {
        seed:
          options.seed !== undefined && options.seed >= 0
            ? options.seed
            : Math.floor(Math.random() * 2_000_000_000),
        steps: options.steps ?? 24,
        cfg: options.cfg ?? 3.5,
        sampler_name: "euler",
        scheduler: "simple",
        denoise: 1,
        model: ["4", 0],
        positive: [imageName ? "15" : "6", 0],
        negative: ["7", 0],
        latent_image: ["5", 0],
      },
    },
    "8": {
      class_type: "VAEDecode",
      inputs: { samples: ["3", 0], vae: ["13", 0] },
    },
    "9": {
      class_type: "SaveImage",
      inputs: { filename_prefix: "snofs", images: ["8", 0] },
    },
  };
}

// Autogrow inputs use dotted paths so ComfyUI groups them into images.
function qwenReferences(
  imageNames: readonly string[],
  width: number,
  height: number,
): { inputs: WorkflowNode["inputs"]; nodes: { [key: string]: WorkflowNode } } {
  const inputs: WorkflowNode["inputs"] = {};
  const nodes: { [key: string]: WorkflowNode } = {};
  imageNames.forEach((image, index) => {
    const loadId = index === 0 ? "10" : String(100 + index * 2);
    const scaleId = index === 0 ? "14" : String(101 + index * 2);
    nodes[loadId] = { class_type: "LoadImage", inputs: { image } };
    nodes[scaleId] = {
      class_type: "ImageScale",
      inputs: {
        image: [loadId, 0],
        upscale_method: "lanczos",
        width,
        height,
        crop: "center",
      },
    };
    inputs[`images.image_${index + 1}`] = [scaleId, 0];
  });
  return { inputs, nodes };
}

function noctWorkflow(
  options: ImageOptions,
  imageNames: readonly string[],
  width: number,
  height: number,
): { [key: string]: WorkflowNode } {
  const references = qwenReferences(imageNames, width, height);
  return {
    "4": {
      class_type: "UNETLoader",
      inputs: {
        unet_name: "noct-q-v4-base.safetensors",
        weight_dtype: "default",
      },
    },
    "12": {
      class_type: "CLIPLoader",
      inputs: {
        clip_name: "qwen3vl_8b_int8_convrot.safetensors",
        type: "qwen_image",
      },
    },
    "13": {
      class_type: "VAELoader",
      inputs: { vae_name: "qwen_image_2.1_vae_bf16.safetensors" },
    },
    "6": {
      class_type: "TextEncodeQwenImage21",
      inputs: {
        clip: ["12", 0],
        prompt: options.prompt,
        negative_prompt: options.negative ?? "",
        vae: ["13", 0],
        resolution: imageNames.length ? 0 : Math.max(width, height),
        ...references.inputs,
      },
    },
    ...references.nodes,
    "5": imageNames.length
      ? {
          class_type: "RepeatLatentBatch",
          inputs: { samples: ["6", 2], amount: options.count ?? 1 },
        }
      : {
          class_type: "EmptyLatentImage",
          inputs: { width, height, batch_size: options.count ?? 1 },
        },
    "3": {
      class_type: "KSampler",
      inputs: {
        seed:
          options.seed !== undefined && options.seed >= 0
            ? options.seed
            : Math.floor(Math.random() * 2_000_000_000),
        steps: options.steps ?? 25,
        cfg: options.cfg ?? 3,
        sampler_name: "euler",
        scheduler: "simple",
        denoise: 1,
        model: ["4", 0],
        positive: ["6", 0],
        negative: ["6", 1],
        latent_image: ["5", 0],
      },
    },
    "8": {
      class_type: "VAEDecode",
      inputs: { samples: ["3", 0], vae: ["13", 0] },
    },
    "9": {
      class_type: "SaveImage",
      inputs: { filename_prefix: "noctq", images: ["8", 0] },
    },
  };
}

function qwenWorkflow(
  options: ImageOptions,
  imageNames: readonly string[],
  width: number,
  height: number,
): { [key: string]: WorkflowNode } {
  const references = qwenReferences(imageNames, width, height);
  return {
    "4": {
      class_type: "UNETLoader",
      inputs: {
        unet_name: "qwen_image_2.1_int8_convrot.safetensors",
        weight_dtype: "default",
      },
    },
    "12": {
      class_type: "CLIPLoader",
      inputs: {
        clip_name: "qwen3vl_8b_int8_convrot.safetensors",
        type: "qwen_image",
      },
    },
    "13": {
      class_type: "VAELoader",
      inputs: { vae_name: "qwen_image_2.1_vae_bf16.safetensors" },
    },
    "16": {
      class_type: "LoraLoader",
      inputs: {
        model: ["4", 0],
        clip: ["12", 0],
        lora_name: "thesealpacas-nsfw-qwen21-v2.safetensors",
        strength_model: 0.8,
        strength_clip: 0.8,
      },
    },
    "6": {
      class_type: "TextEncodeQwenImage21",
      inputs: {
        clip: ["16", 1],
        prompt: options.prompt,
        negative_prompt: options.negative ?? "",
        vae: ["13", 0],
        resolution: imageNames.length ? 0 : Math.max(width, height),
        ...references.inputs,
      },
    },
    ...references.nodes,
    "5": imageNames.length
      ? {
          class_type: "RepeatLatentBatch",
          inputs: { samples: ["6", 2], amount: options.count ?? 1 },
        }
      : {
          class_type: "EmptyLatentImage",
          inputs: { width, height, batch_size: options.count ?? 1 },
        },
    "3": {
      class_type: "KSampler",
      inputs: {
        seed:
          options.seed !== undefined && options.seed >= 0
            ? options.seed
            : Math.floor(Math.random() * 2_000_000_000),
        steps: options.steps ?? 28,
        cfg: options.cfg ?? 4,
        sampler_name: "er_sde",
        scheduler: "beta",
        denoise: 1,
        model: ["16", 0],
        positive: ["6", 0],
        negative: ["6", 1],
        latent_image: ["5", 0],
      },
    },
    "8": {
      class_type: "VAEDecode",
      inputs: { samples: ["3", 0], vae: ["13", 0] },
    },
    "9": {
      class_type: "SaveImage",
      inputs: { filename_prefix: "qwen-lora", images: ["8", 0] },
    },
  };
}

async function generateBatch(
  options: ImageOptions,
  onStatus: (status: string) => void = () => {},
  signal?: AbortSignal,
  onProgress: (progress: SamplingProgress | null) => void = () => {},
  onGenerated: () => void = () => {},
): Promise<Uint8Array[]> {
  let base = options.url;
  while (base.endsWith("/")) base = base.slice(0, -1);
  const { origin } = new URL(base);
  const timeout = AbortSignal.timeout(10 * (options.count ?? 1) * 60 * 1000);
  const operationSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  async function request(
    path: string,
    init: RequestInit = {},
  ): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("User-Agent", "Mozilla/5.0");
    headers.set("Origin", origin);
    headers.set("Referer", `${origin}/`);
    const response = await fetch(`${base}${path}`, {
      ...init,
      headers,
      redirect: "error",
      signal: AbortSignal.any([operationSignal, AbortSignal.timeout(180000)]),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw Error(
        `ComfyUI request failed (${response.status} ${response.statusText})`,
      );
    }
    return response;
  }
  const sourceImages = options.images ?? [];
  const imageNames: string[] = [];
  for (const [index, image] of sourceImages.entries()) {
    onStatus(`Uploading image ${index + 1}/${sourceImages.length}…`);
    const form = new FormData();
    const extension =
      { "image/jpeg": "jpg", "image/webp": "webp" }[image.type] ?? "png";
    form.set("image", image, `${randomUUID()}.${extension}`);
    form.set("overwrite", "false");
    const upload = (await (
      await request("/upload/image", { method: "POST", body: form })
    ).json()) as { name?: string; subfolder?: string };
    if (!upload.name)
      throw Error("ComfyUI did not return an uploaded image name");
    imageNames.push(
      upload.subfolder ? `${upload.subfolder}/${upload.name}` : upload.name,
    );
  }
  const width = options.width ?? 1024;
  const height = options.height ?? 1024;
  if (
    ![width, height].every(
      (value) =>
        Number.isInteger(value) &&
        value >= 64 &&
        value <= 2048 &&
        value % 16 === 0,
    )
  )
    throw Error("Width and height must be 64–2048 pixels, in multiples of 16.");
  const model =
    !options.model || options.model === "auto"
      ? imageNames.length
        ? "snofs"
        : "noct-q"
      : options.model;
  if (
    (model === "noct-q" || model === "qwen-lora") &&
    (width % 32 !== 0 || height % 32 !== 0)
  )
    throw Error("Qwen width and height must be multiples of 32.");

  const workflow =
    model === "snofs"
      ? snofsWorkflow(options, imageNames[0] ?? null, width, height)
      : model === "qwen-lora"
        ? qwenWorkflow(options, imageNames, width, height)
        : noctWorkflow(options, imageNames, width, height);
  const clientId = randomUUID();
  const watcher = await watchProgress(
    base,
    clientId,
    operationSignal,
    model === "snofs"
      ? kleinStages
      : model === "qwen-lora"
        ? qwenStages
        : noctStages,
    onStatus,
    onProgress,
  ).catch(() => ({ setPrompt(): void {}, close(): void {} }));
  let images: ComfyImage[] = [];
  try {
    onStatus(
      `Queuing ${model === "snofs" ? "SNOFS" : model === "qwen-lora" ? "Qwen 2.1 + LoRA" : "Noct Q"} ${imageNames.length ? "edit" : "generation"}…`,
    );
    const queued = (await (
      await request("/prompt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: workflow, client_id: clientId }),
      })
    ).json()) as { prompt_id?: string; error?: unknown; node_errors?: unknown };
    if (!queued.prompt_id) {
      throw Error(
        `ComfyUI did not return a prompt ID${queued.error ? `: ${JSON.stringify(queued.error)}` : ""}`,
      );
    }
    onStatus("Queued; generating image…");
    watcher.setPrompt(queued.prompt_id);
    const deadline = Date.now() + 8 * (options.count ?? 1) * 60 * 1000;
    while (Date.now() < deadline) {
      const history = (await (
        await request(`/history/${encodeURIComponent(queued.prompt_id)}`)
      ).json()) as {
        [key: string]: {
          outputs?: { [key: string]: { images?: ComfyImage[] } };
          status?: {
            status_str?: string;
            messages?: [
              string,
              { exception_type?: string; exception_message?: string },
            ][];
          };
        };
      };
      const entry = history[queued.prompt_id];
      if (entry?.status?.status_str === "error") {
        const failure = entry.status.messages?.find(
          ([kind]) => kind === "execution_error",
        )?.[1];
        const detail = `${failure?.exception_type ?? ""} ${failure?.exception_message ?? ""}`;
        if (
          /outofmemoryerror|cuda out of memory|cuda error: out of memory|hip out of memory/iu.test(
            detail,
          )
        ) {
          throw new GPUOutOfMemoryError(
            "GPU ran out of memory. Reduce the image dimensions.",
          );
        }
        throw Error("ComfyUI image generation failed; check the service logs");
      }
      images = entry?.outputs?.["9"]?.images ?? [];
      if (images.length) break;
      await delay(1500, undefined, { signal: operationSignal });
    }
    if (!images.length) throw Error("Timed out waiting for the images");
    if (images.length !== (options.count ?? 1))
      throw Error("ComfyUI returned an incomplete batch");
  } finally {
    watcher.close();
    onProgress(null);
  }
  onGenerated();
  const results: Uint8Array[] = [];
  for (const image of images) {
    onStatus("Downloading image…");
    const query = new URLSearchParams({
      filename: image.filename,
      subfolder: image.subfolder ?? "",
      type: image.type ?? "output",
    });
    const download = await request(`/view?${query}`);
    const reader = download.body?.getReader();
    if (!reader) throw Error("ComfyUI returned no image");
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 64 * 1024 * 1024) throw Error("Image exceeds 64 MiB");
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    const bytes = Buffer.concat(chunks);
    if (
      !bytes
        .subarray(0, 8)
        .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    )
      throw Error("ComfyUI returned an invalid PNG");
    results.push(bytes);
  }
  return results;
}

export async function generateImages(
  options: ImageOptions,
  onStatus: (status: string) => void = () => {},
  signal?: AbortSignal,
  onProgress: (progress: SamplingProgress | null) => void = () => {},
  onGenerated: () => void = () => {},
): Promise<Uint8Array[]> {
  if (
    options.model &&
    !["auto", "noct-q", "qwen-lora", "snofs"].includes(options.model)
  )
    throw Error("Unknown image model");
  const sourceImages = options.images ?? [];
  const maxImages =
    options.model === "noct-q" || options.model === "qwen-lora" ? 16 : 1;
  if (sourceImages.length > maxImages)
    throw Error(`This model supports up to ${maxImages} input image(s)`);
  const count = options.count ?? 1;
  if (![1, 2, 4, 8].includes(count))
    throw Error("Image count must be 1, 2, 4, or 8");
  const images: Uint8Array[] = [];
  const seed =
    options.seed !== undefined && options.seed >= 0
      ? options.seed
      : Math.floor(Math.random() * 2_000_000_000);
  let batchSize = count;
  while (images.length < count) {
    signal?.throwIfAborted();
    const size = Math.min(batchSize, count - images.length);
    try {
      const batch = await generateBatch(
        { ...options, count: size, seed: seed + images.length },
        (status) =>
          onStatus(`${images.length}/${count} images complete · ${status}`),
        signal,
        onProgress,
        () => {
          if (images.length + size === count) onGenerated();
        },
      );
      images.push(...batch);
    } catch (error) {
      if (!(error instanceof GPUOutOfMemoryError) || size === 1) throw error;
      batchSize = size / 2;
      onStatus(`GPU memory full; retrying ${batchSize} image(s) at a time…`);
      await delay(1500, undefined, { signal });
    }
  }
  return images;
}

async function main(): Promise<void> {
  try {
    const { values } = parseArgs({
      options: {
        url: { type: "string" },
        prompt: { type: "string" },
        image: { type: "string", multiple: true },
        model: { type: "string", default: "auto" },
        negative: { type: "string" },
        width: { type: "string" },
        height: { type: "string" },
        steps: { type: "string" },
        count: { type: "string" },
        cfg: { type: "string" },
        seed: { type: "string" },
        out: { type: "string", default: "image-out.png" },
      },
    });
    const url = values.url ?? process.env.COMFY_URL;
    if (!url || !values.prompt) {
      throw Error(
        "Usage: antigone-generate --url URL --prompt TEXT [--image FILE]... [--model auto|noct-q|qwen-lora|snofs] [--count 1|2|4|8] [--out FILE]",
      );
    }
    const numeric = (
      name: "width" | "height" | "steps" | "cfg" | "seed" | "count",
    ): number | undefined => {
      const value = values[name];
      if (value === undefined) return undefined;
      if (!value.trim() || !Number.isFinite(Number(value)))
        throw Error(`Invalid --${name}`);
      return Number(value);
    };
    if (values.out === "-" && (numeric("count") ?? 1) !== 1)
      throw Error("Use an output filename for multiple images");
    if (!["auto", "noct-q", "qwen-lora", "snofs"].includes(values.model))
      throw Error("Unknown image model");
    const images = await generateImages(
      {
        url,
        prompt: values.prompt,
        model: values.model as ImageOptions["model"],
        images: values.image?.map((path) => Bun.file(path)),
        negative: values.negative,
        width: numeric("width"),
        height: numeric("height"),
        steps: numeric("steps"),
        count: numeric("count"),
        cfg: numeric("cfg"),
        seed: numeric("seed"),
      },
      (status) => console.error(status),
    );
    if (values.out === "-") {
      await Bun.write(Bun.stdout, images[0]!);
    } else {
      for (const [index, bytes] of images.entries()) {
        const path =
          images.length === 1
            ? values.out
            : `${values.out.replace(/\.png$/iu, "")}-${index + 1}.png`;
        await Bun.write(path, bytes);
        console.error(`Wrote ${path}`);
      }
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (import.meta.main) void main();
