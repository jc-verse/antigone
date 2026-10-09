import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "../db/db.server";
import { generationAssets, generationJobs } from "../db/schema";
import type { GenerationInput, GenerationJob, StoredImage } from "./generation";

interface ImageAsset {
  name: string;
  type: string;
  data: Uint8Array;
}

// Share subscriptions with the worker across development module reloads.
const runtime = globalThis as typeof globalThis & {
  antigoneQueueEvents?: { listeners: Set<() => void>; pending: boolean };
  antigoneUploads?: Map<string, ImageAsset>;
};
runtime.antigoneUploads ??= new Map();
const uploads = runtime.antigoneUploads;
runtime.antigoneQueueEvents ??= {
  listeners: new Set<() => void>(),
  pending: false,
};
const events = runtime.antigoneQueueEvents;
export function subscribeQueue(listener: () => void): () => void {
  events.listeners.add(listener);
  return () => {
    events.listeners.delete(listener);
  };
}
export function notifyQueue(): void {
  if (events.pending) return;
  events.pending = true;
  // Read snapshots after the current SQLite transaction commits.
  queueMicrotask(() => {
    events.pending = false;
    for (const listener of events.listeners) {
      try {
        listener();
      } catch (error) {
        console.error("Queue subscriber failed", error);
      }
    }
  });
}

export function listJobs(): GenerationJob[] {
  return db
    .select({ state: generationJobs.state })
    .from(generationJobs)
    .orderBy(generationJobs.sequence)
    .all()
    .map(({ state }) => JSON.parse(state) as GenerationJob);
}
export function getJob(id: string): GenerationJob | null {
  const row = db
    .select({ state: generationJobs.state })
    .from(generationJobs)
    .where(eq(generationJobs.id, id))
    .get();
  return row ? (JSON.parse(row.state) as GenerationJob) : null;
}
export function updateJob(id: string, patch: Partial<GenerationJob>): void {
  const job = getJob(id);
  if (job) {
    db.update(generationJobs)
      .set({ state: JSON.stringify({ ...job, ...patch }) })
      .where(eq(generationJobs.id, id))
      .run();
    notifyQueue();
  }
}
export function getAsset(id: string): ImageAsset | null {
  const upload = uploads.get(id);
  if (upload) return upload;
  return (
    db
      .select({
        name: generationAssets.name,
        type: generationAssets.type,
        data: generationAssets.data,
      })
      .from(generationAssets)
      .where(eq(generationAssets.id, id))
      .get() ?? null
  );
}
function saveAsset(
  jobId: string,
  name: string,
  type: string,
  bytes: Uint8Array,
): StoredImage {
  const id = randomUUID();
  db.insert(generationAssets)
    .values({ id, jobId, name, type, data: Buffer.from(bytes) })
    .run();
  return { id, name, url: `/api/asset?id=${id}` };
}
export async function enqueueJob(
  input: Omit<GenerationInput, "sourceImages"> & { sourceImages: File[] },
): Promise<GenerationJob> {
  const inputs = await Promise.all(
    input.sourceImages.map(async (file) => ({
      name: file.name,
      type: file.type,
      bytes: new Uint8Array(await file.arrayBuffer()),
    })),
  );
  return db.transaction(() => {
    const id = randomUUID();
    const job: GenerationJob = {
      id,
      createdAt: Date.now(),
      input: {
        ...input,
        sourceImages: inputs.map((file) =>
          saveAsset(id, file.name, file.type, file.bytes),
        ),
      },
      outputs: [],
      phase: "queued",
      status: "Queued",
      sampling: null,
    };
    db.insert(generationJobs)
      .values({ id, createdAt: job.createdAt, state: JSON.stringify(job) })
      .run();
    notifyQueue();
    return job;
  });
}
export function completeJob(id: string, images: Uint8Array[]): void {
  db.transaction(() => {
    const outputs = images.map((bytes, index) =>
      saveAsset(id, `antigone-${index + 1}.png`, "image/png", bytes),
    );
    updateJob(id, {
      outputs,
      phase: "complete",
      status: "Saved to library",
      sampling: null,
    });
  });
}
export function removeJob(id: string): boolean {
  return db.transaction(() => {
    const job = getJob(id);
    if (!job || job.phase === "generating" || job.phase === "downloading")
      return false;
    db.delete(generationAssets).where(eq(generationAssets.jobId, id)).run();
    db.delete(generationJobs).where(eq(generationJobs.id, id)).run();
    notifyQueue();
    return true;
  });
}

export async function saveUploads(files: File[]): Promise<StoredImage[]> {
  const images = await Promise.all(
    files.map(async (file) => ({
      file,
      bytes: new Uint8Array(await file.arrayBuffer()),
    })),
  );
  return images.map(({ file, bytes }) => {
    const id = randomUUID();
    uploads.set(id, { name: file.name, type: file.type, data: bytes });
    // Reclaim abandoned form uploads even if the browser never sends cleanup.
    setTimeout(() => uploads.delete(id), 24 * 60 * 60 * 1000).unref();
    return { id, name: file.name, url: `/api/asset?id=${id}` };
  });
}
export function removeUpload(id: string): void {
  uploads.delete(id);
}
