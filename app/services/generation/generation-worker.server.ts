import { eq } from "drizzle-orm";
import { generateImages, type ImageOptions } from "./runpod_client";
import type { SetupState } from "../runpod/runpod_provisioner";
import { db } from "../db/db.server";
import { runpodSetup } from "../db/schema";
import {
  completeJob,
  getAsset,
  listJobs,
  updateJob,
} from "./generation-store.server";
import type { GenerationJob } from "./generation";

// One worker per server process, including development module reloads.
const runtime = globalThis as typeof globalThis & {
  antigoneWorker?: { kick: () => void };
};

function gpuURL(model?: string): string | null {
  const row = db.select().from(runpodSetup).where(eq(runpodSetup.id, 1)).get();
  const setup = row ? (JSON.parse(row.state) as SetupState) : null;
  return setup?.status === "ready" &&
    (!model || setup.models.some((id) => id === model)) &&
    setup.podId &&
    /^[\w-]+$/u.test(setup.podId)
    ? `https://${setup.podId}-8188.proxy.runpod.net`
    : null;
}
function createWorker(): { kick: () => void } {
  // A restart cannot safely infer whether an interrupted GPU request succeeded.
  // Keep the inputs for explicit retry without duplicating GPU runs.
  for (const job of listJobs()) {
    if (job.phase === "generating" || job.phase === "downloading") {
      updateJob(job.id, {
        phase: "failed",
        status: "Server restarted during this job. Retry to generate it again.",
        sampling: null,
      });
    }
  }
  let gpuJob: string | null = null;
  function kick(): void {
    if (gpuJob) return;
    const url = gpuURL();
    if (!url) return;
    const job = listJobs().find((candidate) => {
      if (candidate.phase !== "queued") return false;
      if (gpuURL(candidate.input.model)) return true;
      updateJob(candidate.id, {
        phase: "failed",
        status: `The configured GPU does not have ${candidate.input.model} installed. Retry after setting up a GPU with this model.`,
        sampling: null,
      });
      return false;
    });
    if (!job) return;
    gpuJob = job.id;
    updateJob(job.id, { phase: "generating", status: "Connecting…" });
    void run(job, url).catch((error: unknown) =>
      console.error("Generation worker failed", error),
    );
  }
  async function run(job: GenerationJob, url: string): Promise<void> {
    const release = (): void => {
      if (gpuJob === job.id) gpuJob = null;
      kick();
    };
    try {
      const images = job.input.sourceImages.map(({ id }) => {
        const asset = getAsset(id);
        if (!asset)
          throw Error("An input image is missing from server storage");
        return new File([new Uint8Array(asset.data)], asset.name, {
          type: asset.type,
        });
      });
      const outputs = await generateImages(
        {
          url,
          images,
          prompt: job.input.prompt,
          model: job.input.model as ImageOptions["model"],
          width: Number(job.input.width),
          height: Number(job.input.height),
          steps: Number(job.input.steps),
          count: Number(job.input.count),
        },
        (status) => updateJob(job.id, { status }),
        undefined,
        (sampling) => updateJob(job.id, { sampling }),
        () => {
          updateJob(job.id, {
            phase: "downloading",
            status: "Downloading…",
            sampling: null,
          });
          release();
        },
      );
      completeJob(job.id, outputs);
    } catch (error) {
      updateJob(job.id, {
        phase: "failed",
        status: error instanceof Error ? error.message : "Generation failed",
        sampling: null,
      });
    } finally {
      release();
    }
  }
  const timer = setInterval(() => {
    try {
      kick();
    } catch (error) {
      console.error("Generation queue unavailable", error);
    }
  }, 1000);
  timer.unref();
  return { kick };
}
runtime.antigoneWorker ??= createWorker();
export const kickQueue = runtime.antigoneWorker.kick;
