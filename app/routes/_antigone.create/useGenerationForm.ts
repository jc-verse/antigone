import { useState, type Dispatch, type SetStateAction } from "react";
import type { StoredImage } from "../../services/generation/generation";

const defaults = {
  prompt: "",
  model: "auto",
  width: "1024",
  height: "1024",
  aspect: "1024,1024",
  steps: "30",
  count: "1",
};
interface GenerationFormState {
  fields: typeof defaults;
  setFields: Dispatch<SetStateAction<typeof defaults>>;
  sourceImages: StoredImage[];
  setSourceImages: Dispatch<SetStateAction<StoredImage[]>>;
}
export default function useGenerationForm(): GenerationFormState {
  const [fields, setFields] = useState(defaults);
  const [sourceImages, setSourceImages] = useState<StoredImage[]>([]);
  return { fields, setFields, sourceImages, setSourceImages };
}
