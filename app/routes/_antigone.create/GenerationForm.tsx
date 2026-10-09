import { useEffect, useRef, useState, type ReactElement } from "react";
import useGenerationForm from "./useGenerationForm";
import type { StoredImage } from "../../services/generation/generation";
import { useGenerationContext, type GenerationInput } from "./useGeneration";
import { autoModel, modelRequirements } from "../../services/generation/models";
import styles from "./GenerationForm.module.css";

const aspectRatios = [
  ["1024,1024", "Square (1:1)"],
  ["1536,864", "Landscape (16:9)"],
  ["864,1536", "Portrait (9:16)"],
  ["1152,864", "Landscape (4:3)"],
  ["864,1152", "Portrait (3:4)"],
] as const;

export default function GenerationForm({
  submitting,
  onGenerate,
}: {
  readonly submitting: boolean;
  readonly onGenerate: (input: GenerationInput) => void;
}): ReactElement {
  const { fields, setFields, sourceImages, setSourceImages } =
    useGenerationForm();
  const sourceImage = sourceImages[0] ?? null;
  const { prompt, width, height, aspect, steps, count, model } = fields;
  const { models } = useGenerationContext();
  const modelChoice = models.find((id) => id === model) ?? "auto";
  const automaticModel = autoModel(models, Boolean(sourceImage));
  const selectedModel = modelChoice === "auto" ? automaticModel : modelChoice;
  const dimensionStep = selectedModel === "snofs" ? 16 : 32;
  const fileInput = useRef<HTMLInputElement>(null);
  const [imageError, setImageError] = useState("");
  const [draggingImage, setDraggingImage] = useState(false);
  const [driveLink, setDriveLink] = useState("");
  const [importingDrive, setImportingDrive] = useState(false);
  const driveRequest = useRef<AbortController | null>(null);
  useEffect(() => () => driveRequest.current?.abort(), []);
  async function importDrive(link: string): Promise<void> {
    if (driveRequest.current || !link.trim()) return;
    const controller = new AbortController();
    driveRequest.current = controller;
    setImportingDrive(true);
    setImageError("");
    try {
      const response = await fetch("/api/drive", {
        method: "POST",
        body: link.trim(),
        signal: controller.signal,
        headers: { "Content-Type": "text/plain" },
      });
      if (response.status === 401) window.location.assign("/auth/login");
      if (!response.ok) {
        throw Error(
          ((await response.json()) as { detail?: string } | undefined)
            ?.detail ?? "Drive import failed",
        );
      }
      const image = (await response.json()) as StoredImage;
      controller.signal.throwIfAborted();
      setSourceImages((previous) => [...previous, image]);
      setDriveLink("");
    } catch (error) {
      if (!controller.signal.aborted) {
        setImageError(
          error instanceof Error ? error.message : "Drive import failed",
        );
      }
    } finally {
      if (driveRequest.current === controller) driveRequest.current = null;
      if (!controller.signal.aborted) setImportingDrive(false);
    }
  }

  const [uploading, setUploading] = useState(0);
  async function addImages(files: File[]): Promise<void> {
    const valid = files.filter(
      (file) =>
        ["image/png", "image/jpeg", "image/webp"].includes(file.type) &&
        file.size > 0 &&
        file.size <= 20 * 1024 * 1024,
    );
    if (!valid.length || valid.length !== files.length) {
      setImageError("Choose PNG, JPEG, or WebP images up to 20 MiB each.");
      return;
    }
    setUploading((previous) => previous + 1);
    setImageError("");
    const body = new FormData();
    valid.forEach((file) => body.append("image", file));
    try {
      const response = await fetch("/api/upload", { method: "POST", body });
      if (response.status === 401) window.location.assign("/auth/login");
      if (!response.ok) {
        throw Error(
          ((await response.json()) as { detail?: string } | undefined)
            ?.detail ?? "Image upload failed",
        );
      }
      const images = (await response.json()) as StoredImage[];
      setSourceImages((previous) => [...previous, ...images]);
    } catch (error) {
      setImageError(
        error instanceof Error ? error.message : "Image upload failed",
      );
    } finally {
      setUploading((previous) => previous - 1);
    }
  }
  async function removeImage(id: string): Promise<void> {
    try {
      const response = await fetch(`/api/upload?id=${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      if (!response.ok) {
        throw Error(
          ((await response.json()) as { detail?: string } | undefined)
            ?.detail ?? "Could not remove image",
        );
      }
      setSourceImages((previous) =>
        previous.filter((image) => image.id !== id),
      );
      setImageError("");
    } catch (error) {
      setImageError(
        error instanceof Error ? error.message : "Could not remove image",
      );
    }
  }
  const setField = (name: keyof typeof fields, value: string): void => {
    setFields((previous) => ({ ...previous, [name]: value }));
  };
  return (
    <form
      className={styles.form}
      onPaste={(event) => {
        const files = Array.from(event.clipboardData.items)
          .filter(
            (entry) => entry.kind === "file" && entry.type.startsWith("image/"),
          )
          .map((item) => item.getAsFile())
          .filter((file): file is File => file !== null);
        if (!files.length) return;
        event.preventDefault();
        void addImages(files);
      }}
      onSubmit={(event) => {
        event.preventDefault();
        if (submitting || importingDrive || uploading || !selectedModel) return;
        if (selectedModel !== "snofs" && sourceImages.length > 16) {
          setImageError(
            "Qwen supports up to 16 input images. Remove extra attachments.",
          );
          return;
        }
        onGenerate({
          prompt,
          width,
          height,
          steps,
          count,
          model: selectedModel,
          sourceImages:
            selectedModel === "snofs" ? sourceImages.slice(0, 1) : sourceImages,
        });
      }}>
      <label className={styles.sr} htmlFor="prompt">
        Your prompt
      </label>
      <textarea
        id="prompt"
        required
        rows={5}
        value={prompt}
        onChange={(event) => setField("prompt", event.target.value)}
        placeholder="Prompt"
      />
      <div className={styles.imageOptions}>
        <label>
          Model{" "}
          <select
            value={modelChoice}
            onChange={(event) => setField("model", event.target.value)}>
            <option value="auto">
              Auto —{" "}
              {automaticModel
                ? modelRequirements[automaticModel].label
                : "Loading models…"}
            </option>
            {models.map((id) => (
              <option key={id} value={id}>
                {modelRequirements[id].label}
              </option>
            ))}
          </select>
        </label>
        <details className={styles.imageChooser}>
          <summary>
            Input images
            {sourceImages.length
              ? ` · ${sourceImages.length} attached`
              : " (optional)"}
          </summary>
          <div className={styles.imagePanel}>
            <label>
              Google Drive image link{" "}
              <input
                type="url"
                value={driveLink}
                disabled={importingDrive}
                placeholder="https://drive.google.com/file/d/…/view"
                onChange={(event) => setDriveLink(event.target.value)}
                onPaste={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  const link = event.clipboardData.getData("text/plain").trim();
                  setDriveLink(link);
                  void importDrive(link);
                }}
              />
            </label>
            <button
              type="button"
              disabled={importingDrive || !driveLink.trim()}
              onClick={() => {
                void importDrive(driveLink);
              }}>
              {importingDrive ? "Importing from Drive…" : "Import image"}
            </button>
            <p className={styles.imageHint}>
              Pasting a link imports the image automatically. Enable
              anyone-with-the-link access and allow downloads. PNG, JPEG, or
              WebP · Up to 20 MiB.
            </p>
            <input
              ref={fileInput}
              type="file"
              multiple
              hidden
              accept="image/png,image/jpeg,image/webp"
              aria-label="Choose input images"
              onChange={(event) => {
                void addImages(Array.from(event.target.files ?? []));
                event.target.value = "";
              }}
            />
            <button
              type="button"
              className={styles.imageDropzone}
              data-dragging={draggingImage || undefined}
              onClick={() => fileInput.current?.click()}
              onDragOver={(event) => {
                event.preventDefault();
                event.dataTransfer.dropEffect = "copy";
                setDraggingImage(true);
              }}
              onDragLeave={(event) => {
                if (
                  !event.currentTarget.contains(
                    event.relatedTarget as Node | null,
                  )
                )
                  setDraggingImage(false);
              }}
              onDrop={(event) => {
                event.preventDefault();
                setDraggingImage(false);
                void addImages(Array.from(event.dataTransfer.files));
              }}>
              <span>
                {draggingImage
                  ? "Drop images here"
                  : "Paste, drop, or click to select images"}
              </span>
              <span className={styles.imageHint}>
                PNG, JPEG, or WebP · Up to 20 MiB each · ⌘V / Ctrl+V to paste
              </span>
            </button>
            {uploading > 0 && <output>Uploading images to server…</output>}
            {sourceImages.map((image, index) => (
              <div className={styles.selectedImage} key={image.id}>
                <img src={image.url} alt="" className={styles.thumbnail} />
                <span>
                  {image.name}
                  {selectedModel !== "snofs" || index === 0
                    ? ` · Reference ${index + 1}`
                    : ""}
                </span>
                <button
                  type="button"
                  aria-label={`Remove ${image.name}`}
                  disabled={submitting}
                  onClick={() => {
                    void removeImage(image.id);
                  }}>
                  Remove
                </button>
              </div>
            ))}
            {sourceImages.length > 0 && (
              <p className={styles.imageHint}>
                {selectedModel === "snofs"
                  ? "Only the first attached image is sent for generation."
                  : "All attached images are sent in order as references (up to 16)."}
              </p>
            )}
            {imageError && (
              <p role="alert" className={styles.dimensionsHelp}>
                {imageError}
              </p>
            )}
          </div>
        </details>
        <label>
          Aspect ratio{" "}
          <select
            value={
              aspectRatios.some(([value]) => value === aspect)
                ? aspect
                : "custom"
            }
            onChange={(event) => {
              const { value } = event.target;
              if (value === "custom") {
                setField("aspect", value);
                return;
              }
              const [nextWidth, nextHeight] = value.split(",");
              setFields((previous) => ({
                ...previous,
                aspect: value,
                width: nextWidth!,
                height: nextHeight!,
              }));
            }}>
            {aspectRatios.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
            <option value="custom">Custom</option>
          </select>
        </label>
        {(["width", "height"] as const).map((dimension) => (
          <label key={dimension}>
            {dimension === "width" ? "Width (px)" : "Height (px)"}{" "}
            <input
              type="number"
              required
              min={64}
              max={2048}
              step={dimensionStep}
              value={fields[dimension]}
              aria-describedby="dimensions-help"
              onChange={(event) =>
                setFields((previous) => ({
                  ...previous,
                  [dimension]: event.target.value,
                  aspect: "custom",
                }))
              }
            />
          </label>
        ))}
        <p id="dimensions-help" className={styles.dimensionsHelp}>
          Output: 64–2048 pixels per side, in multiples of {dimensionStep}.
          {sourceImage &&
            (selectedModel !== "snofs"
              ? " The reference image is resized and center-cropped to the output dimensions."
              : " The reference image keeps its aspect ratio; output uses the dimensions above.")}
        </p>
        <label>
          Images{" "}
          <select
            value={count}
            onChange={(event) => setField("count", event.target.value)}>
            {[1, 2, 4, 8].map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
        <label>
          Steps{" "}
          <input
            type="number"
            value={steps}
            min={1}
            max={80}
            required
            onChange={(event) => setField("steps", event.target.value)}
          />
        </label>
      </div>
      <div className={styles.toolbar}>
        <div className={styles.generationProgress}>
          <output id="submission-status">
            {submitting
              ? "Sending job to server…"
              : importingDrive
                ? "Importing from Drive…"
                : uploading > 0
                  ? "Uploading images to server…"
                  : ""}
          </output>
          {(submitting || importingDrive || uploading > 0) && (
            <progress
              aria-label="Upload progress"
              aria-describedby="submission-status"
            />
          )}
        </div>
        <button
          className={styles.primary}
          type="submit"
          disabled={
            !selectedModel ||
            submitting ||
            importingDrive ||
            uploading > 0 ||
            !prompt.trim()
          }>
          {submitting ? "Adding to queue…" : "Add to queue +"}
        </button>
      </div>
    </form>
  );
}
