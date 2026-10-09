import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import {
  requireOwnerSession,
  requireSameOrigin,
} from "../../services/auth/auth.server";

import {
  enqueueJob,
  getAsset,
  getJob,
  removeJob,
  updateJob,
  saveUploads,
  removeUpload,
} from "../../services/generation/generation-store.server";
import { streamQueue } from "../../services/generation/queue-stream.server";
import { kickQueue } from "../../services/generation/generation-worker.server";
import { generationModels } from "../../services/generation/generation-models.server";
import { autoModel } from "../../services/generation/models";
import {
  imageType,
  importDriveImage,
  readLimitedBody,
} from "../../services/generation/drive-import.server";

export async function loader({
  request,
  params,
}: LoaderFunctionArgs): Promise<Response> {
  await requireOwnerSession(request);
  if (params.kind === "queue") return streamQueue(request);
  if (params.kind === "asset") {
    const asset = getAsset(new URL(request.url).searchParams.get("id") ?? "");
    if (!asset)
      throw Response.json({ detail: "Image not found" }, { status: 404 });
    return new Response(new Uint8Array(asset.data), {
      headers: {
        "Content-Type": asset.type,
        "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(asset.name)}`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  }
  throw Response.json({ detail: "Not found" }, { status: 404 });
}
export async function action({
  request,
  params,
}: ActionFunctionArgs): Promise<Response> {
  await requireOwnerSession(request);
  requireSameOrigin(request);
  const id = new URL(request.url).searchParams.get("id") ?? "";
  if (params.kind === "upload" && request.method === "DELETE") {
    removeUpload(id);
    return Response.json({ ok: true });
  }
  if (params.kind === "job" && request.method === "DELETE") {
    if (!removeJob(id)) {
      throw Response.json(
        { detail: "This job is running or no longer exists" },
        { status: 409 },
      );
    }
    return Response.json({ ok: true });
  }
  if (request.method !== "POST")
    throw Response.json({ detail: "Method not allowed" }, { status: 405 });
  if (params.kind === "retry") {
    if (getJob(id)?.phase !== "failed") {
      throw Response.json(
        { detail: "Only failed jobs can be retried" },
        { status: 409 },
      );
    }
    updateJob(id, { phase: "queued", status: "Queued", sampling: null });
    kickQueue();
    return Response.json({ ok: true });
  }
  if (params.kind === "drive") {
    try {
      const link = new TextDecoder().decode(
        await readLimitedBody(request, 4096),
      );
      const image = await importDriveImage(link, request.signal);
      const [stored] = await saveUploads([
        new File([new Uint8Array(image.bytes)], image.name, {
          type: image.type,
        }),
      ]);
      return Response.json(stored, { status: 201 });
    } catch (error) {
      throw Response.json(
        {
          detail:
            error instanceof Error ? error.message : "Drive import failed",
        },
        { status: 400 },
      );
    }
  }
  const uploading = params.kind === "upload";
  if (!uploading && params.kind !== "image")
    throw Response.json({ detail: "Not found" }, { status: 404 });
  let form = new FormData();
  if (params.kind === "image") {
    const payload: unknown = await readLimitedBody(request, 128 * 1024)
      .then((bytes) => JSON.parse(new TextDecoder().decode(bytes)) as unknown)
      .catch(() => {
        throw Response.json(
          { detail: "Invalid job submission" },
          { status: 400 },
        );
      });
    if (!payload || typeof payload !== "object") {
      throw Response.json(
        { detail: "Invalid job submission" },
        { status: 400 },
      );
    }
    const input = payload as { [key: string]: unknown };
    for (const key of [
      "prompt",
      "model",
      "width",
      "height",
      "steps",
      "count",
    ]) {
      const value = input[key];
      if (typeof value !== "string" && typeof value !== "number")
        throw Response.json({ detail: `Invalid ${key}` }, { status: 400 });
      form.set(key, String(value));
    }
    if (!Array.isArray(input.sourceImages) || input.sourceImages.length > 16) {
      throw Response.json(
        { detail: "Choose up to 16 server images" },
        { status: 400 },
      );
    }
    for (const assetId of input.sourceImages as unknown[]) {
      if (typeof assetId !== "string") {
        throw Response.json(
          { detail: "Invalid image reference" },
          { status: 400 },
        );
      }
      const asset = getAsset(assetId);
      if (!asset) {
        throw Response.json(
          {
            detail:
              "An input image no longer exists on the server. Refresh the attachments.",
          },
          { status: 400 },
        );
      }
      form.append(
        "image",
        new File([new Uint8Array(asset.data)], asset.name, {
          type: asset.type,
        }),
      );
    }
  } else {
    const contentType = request.headers.get("Content-Type") ?? "";
    if (!contentType.startsWith("multipart/form-data")) {
      throw Response.json(
        { detail: "Expected an image upload" },
        { status: 400 },
      );
    }
    const bytes = await readLimitedBody(request, 321 * 1024 * 1024)
      .then((body) => new Uint8Array(body))
      .catch(() => {
        throw Response.json(
          { detail: "Image upload exceeds the size limit or was interrupted" },
          { status: 413 },
        );
      });
    form = await new Response(bytes, {
      headers: { "Content-Type": contentType },
    })
      .formData()
      .catch(() => {
        throw Response.json(
          { detail: "Invalid image upload" },
          { status: 400 },
        );
      });
  }
  const sourceImages = form.getAll("image");
  if (sourceImages.length > 16) {
    throw Response.json(
      { detail: "Choose up to 16 input images" },
      { status: 400 },
    );
  }
  const inputImages: File[] = [];
  for (const image of sourceImages) {
    if (
      typeof image === "string" ||
      !["image/png", "image/jpeg", "image/webp"].includes(image.type) ||
      image.size > 20 * 1024 * 1024 ||
      !image.size
    ) {
      throw Response.json(
        { detail: "Choose PNG, JPEG, or WebP images up to 20 MiB each" },
        { status: 400 },
      );
    }
    inputImages.push(image);
  }
  if (uploading) {
    if (!inputImages.length) {
      throw Response.json(
        { detail: "Choose an image to upload" },
        { status: 400 },
      );
    }
    for (const image of inputImages) {
      if (
        imageType(new Uint8Array(await image.slice(0, 12).arrayBuffer())) !==
        image.type
      ) {
        throw Response.json(
          { detail: "The file is not a valid PNG, JPEG, or WebP image" },
          { status: 400 },
        );
      }
    }
    return Response.json(await saveUploads(inputImages), { status: 201 });
  }
  const prompt = form.get("prompt");
  if (typeof prompt !== "string" || !prompt.trim() || prompt.length > 32000) {
    throw Response.json(
      { detail: "Enter a prompt of up to 32,000 characters" },
      { status: 400 },
    );
  }
  const model = form.get("model") ?? "auto";
  if (
    model !== "auto" &&
    model !== "noct-q" &&
    model !== "qwen-lora" &&
    model !== "snofs"
  )
    throw Response.json({ detail: "Unknown image model" }, { status: 400 });
  const models = generationModels();
  const selectedModel =
    model === "auto" ? autoModel(models, inputImages.length > 0) : model;
  if (!selectedModel || !models.includes(selectedModel)) {
    throw Response.json(
      {
        detail:
          "This model is unavailable for the current GPU setup. Choose an available model.",
      },
      { status: 400 },
    );
  }
  if (selectedModel === "snofs" && inputImages.length > 1) {
    throw Response.json(
      { detail: "SNOFS supports one input image" },
      { status: 400 },
    );
  }
  const dimensionStep = selectedModel === "snofs" ? 16 : 32;
  for (const [name, min, max] of [
    ["steps", 1, 80],
    ["width", 64, 2048],
    ["height", 64, 2048],
  ] as const) {
    const raw = form.get(name);
    const value = Number(raw);
    if (
      typeof raw !== "string" ||
      !raw.trim() ||
      !Number.isFinite(value) ||
      value < min ||
      value > max ||
      !Number.isInteger(value) ||
      ((name === "width" || name === "height") && value % dimensionStep !== 0)
    )
      throw Response.json({ detail: `Invalid ${name}` }, { status: 400 });
  }
  const count = Number(form.get("count") ?? 1);
  if (![1, 2, 4, 8].includes(count)) {
    throw Response.json(
      { detail: "Image count must be 1, 2, 4, or 8" },
      { status: 400 },
    );
  }
  const job = await enqueueJob({
    sourceImages: inputImages,
    prompt,
    model: selectedModel,
    width: String(Number(form.get("width"))),
    height: String(Number(form.get("height"))),
    steps: String(Number(form.get("steps"))),
    count: String(count),
  });
  kickQueue();
  return Response.json(job, { status: 201 });
}
