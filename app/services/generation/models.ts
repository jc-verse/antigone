export const modelIds = ["noct-q", "qwen-lora", "snofs"] as const;
export type ModelId = (typeof modelIds)[number];
export const defaultModels: ModelId[] = ["noct-q", "qwen-lora"];
// Exact file bytes from HF LFS metadata and Civitai file metadata, 2026-10-06.
const modelFileBytes: { [file: string]: number } = {
  "snofs-klein-9b-base.safetensors": 18157185200,
  "qwen_3_8b.safetensors": 16381517176,
  "flux2-vae.safetensors": 336211292,
  "noct-q-v4-base.safetensors": 14230280896,
  "qwen3vl_8b_int8_convrot.safetensors": 9350798360,
  "qwen_image_2.1_vae_bf16.safetensors": 675509688,
  "qwen_image_2.1_int8_convrot.safetensors": 7256783064,
  "thesealpacas-nsfw-qwen21-v2.safetensors": 79744352,
};

function modelDownloadBytes(models: readonly ModelId[]): number {
  return requiredModelFiles(models).reduce((total, file) => {
    const bytes = modelFileBytes[file];
    if (!bytes) throw Error(`Missing download size for ${file}`);
    return total + bytes;
  }, 0);
}

export function modelDiskGb(models: readonly ModelId[]): number {
  return Math.ceil((modelDownloadBytes(models) / 1e9 + 8) / 5) * 5;
}
export function autoModel(
  models: readonly ModelId[],
  hasInput: boolean,
): ModelId | undefined {
  const preference: ModelId[] = hasInput
    ? ["snofs", "noct-q", "qwen-lora"]
    : ["noct-q", "qwen-lora", "snofs"];
  return preference.find((model) => models.includes(model));
}
const qwenShared = {
  clip: "qwen3vl_8b_int8_convrot.safetensors",
  vae: "qwen_image_2.1_vae_bf16.safetensors",
  clipType: "qwen_image",
};
export const modelRequirements = {
  "noct-q": {
    label: "Noct Q",
    ...qwenShared,
    unet: "noct-q-v4-base.safetensors",
    loras: [],
    nodes: [
      "TextEncodeQwenImage21",
      "EmptyLatentImage",
      "ImageScale",
      "RepeatLatentBatch",
    ],
    sampler: "euler",
    scheduler: "simple",
  },
  "qwen-lora": {
    label: "Qwen + LoRA",
    ...qwenShared,
    unet: "qwen_image_2.1_int8_convrot.safetensors",
    loras: ["thesealpacas-nsfw-qwen21-v2.safetensors"],
    nodes: [
      "TextEncodeQwenImage21",
      "EmptyLatentImage",
      "ImageScale",
      "RepeatLatentBatch",
      "LoraLoader",
    ],
    sampler: "er_sde",
    scheduler: "beta",
  },
  snofs: {
    label: "SNOFS",
    unet: "snofs-klein-9b-base.safetensors",
    clip: "qwen_3_8b.safetensors",
    vae: "flux2-vae.safetensors",
    clipType: "flux2",
    loras: [],
    nodes: [
      "EmptyFlux2LatentImage",
      "ReferenceLatent",
      "ImageScaleToTotalPixels",
    ],
    sampler: "euler",
    scheduler: "simple",
  },
} satisfies {
  [key in ModelId]: {
    label: string;
    unet: string;
    clip: string;
    vae: string;
    clipType: string;
    loras: string[];
    nodes: string[];
    sampler: string;
    scheduler: string;
  };
};

export function requiredModelFiles(models: readonly ModelId[]): string[] {
  return [
    ...new Set(
      models.flatMap((id) => {
        const model = modelRequirements[id];
        return [model.unet, model.clip, model.vae, ...model.loras];
      }),
    ),
  ];
}
