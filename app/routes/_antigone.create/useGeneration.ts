import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import type {
  GenerationInput,
  GenerationJob,
} from "../../services/generation/generation";
import type { ModelId } from "../../services/generation/models";

export type { GenerationInput } from "../../services/generation/generation";
interface GenerationState {
  submitting: boolean;
  loading: boolean;
  images: string[];
  error: string;
  jobs: GenerationJob[];
  models: ModelId[];
  generate: (input: GenerationInput) => void;
  removeQueued: (id: string) => Promise<void>;
  retryJob: (id: string) => Promise<void>;
}
export const GenerationContext = createContext<GenerationState | null>(null);
export function useGenerationContext(): GenerationState {
  const state = useContext(GenerationContext);
  if (!state) throw Error("Missing generation provider");
  return state;
}
async function api(path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(path, init);
  if (response.status === 401) window.location.assign("/auth/login");
  if (!response.ok) {
    throw Error(
      ((await response.json()) as { detail?: string } | undefined)?.detail ??
        "Request failed",
    );
  }
  return response.json();
}
export default function useGeneration(): GenerationState {
  const [jobs, setJobs] = useState<GenerationJob[]>([]);
  const [models, setModels] = useState<ModelId[]>([]);
  const [previewJobs, setPreviewJobs] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [connectionError, setConnectionError] = useState("");
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const posting = useRef(false);
  useEffect(() => {
    const source = new EventSource("/api/queue");
    source.addEventListener("models", (event: MessageEvent<string>) => {
      setModels(JSON.parse(event.data) as ModelId[]);
    });
    source.onmessage = (event: MessageEvent<string>) => {
      const next = JSON.parse(event.data) as GenerationJob[];
      setJobs(next);
      setConnectionError("");
      setLoading(false);
    };
    source.addEventListener("auth-required", () => {
      source.close();
      window.location.assign("/auth/login");
    });
    source.onerror = () => {
      setConnectionError(
        "Queue updates disconnected. Server jobs continue; reconnecting…",
      );
      setLoading(false);
    };
    return () => source.close();
  }, []);
  function generate(input: GenerationInput): void {
    if (posting.current) return;
    posting.current = true;
    setSubmitting(true);
    setError("");
    void api("/api/image", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...input,
        sourceImages: input.sourceImages.map(({ id }) => id),
      }),
    })
      .then((result) => {
        const job = result as GenerationJob;
        setPreviewJobs((previous) => [...previous, job.id]);
      })
      .catch((failure: unknown) => {
        setError(
          failure instanceof Error
            ? failure.message
            : "The job could not be queued",
        );
      })
      .finally(() => {
        posting.current = false;
        setSubmitting(false);
      });
  }
  const removeQueued = useCallback(async (id: string): Promise<void> => {
    try {
      await api(`/api/job?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      setError("");
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Could not delete this job",
      );
    }
  }, []);
  const retryJob = useCallback(async (id: string): Promise<void> => {
    try {
      await api(`/api/retry?id=${encodeURIComponent(id)}`, { method: "POST" });
      setPreviewJobs((previous) => [...previous, id]);
      setError("");
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : "Could not retry this job",
      );
    }
  }, []);
  const [latest] = jobs
    .filter((job) => job.phase === "complete" && previewJobs.includes(job.id))
    .sort((a, b) => b.createdAt - a.createdAt);
  return {
    submitting,
    loading,
    images: latest?.outputs.map(({ url }) => url) ?? [],
    error: error || connectionError,
    jobs,
    models,
    generate,
    removeQueued,
    retryJob,
  };
}
