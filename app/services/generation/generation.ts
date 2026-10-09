export interface GenerationInput {
  sourceImages: StoredImage[];
  prompt: string;
  model: string;
  width: string;
  height: string;
  steps: number | string;
  count: string;
}
interface SamplingProgress {
  value: number;
  max: number;
}
export interface StoredImage {
  id: string;
  name: string;
  url: string;
}
export interface GenerationJob {
  id: string;
  createdAt: number;
  input: Omit<GenerationInput, "sourceImages"> & {
    sourceImages: StoredImage[];
  };
  phase: "queued" | "generating" | "downloading" | "complete" | "failed";
  status: string;
  sampling: SamplingProgress | null;
  outputs: StoredImage[];
}
