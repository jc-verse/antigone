import { useEffect, useState, type ReactElement } from "react";
import { useFetcher, useLoaderData } from "@remix-run/react";
import {
  defaultModels,
  modelIds,
  modelRequirements,
  modelDiskGb,
  requiredModelFiles,
  type ModelId,
} from "../../services/generation/models";
import type { SetupResponse } from "./route";
import styles from "./RunpodConfig.module.css";

function sizeLabel(bytes: number): string {
  return bytes >= 1024 ** 3
    ? `${(bytes / 1024 ** 3).toFixed(2)} GiB`
    : `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
}

const comfyStageLabels = {
  queued: "Waiting for setup progress…",
  starting: "Starting ComfyUI…",
  checking: "Checking required nodes…",
  ready: "Ready",
  error: "Failed — inspect pod logs",
};

export default function RunpodConfig(): ReactElement {
  const initial = useLoaderData<SetupResponse>();
  const [state, setState] = useState(initial);
  const [selectedModels, setSelectedModels] = useState<ModelId[]>(
    initial.job?.models ?? [...defaultModels],
  );
  const fetcher = useFetcher<SetupResponse | { detail: string }>();
  const { load, data, state: fetchState } = fetcher;
  const pending =
    fetchState !== "idle" &&
    fetcher.formMethod !== "GET" &&
    Boolean(fetcher.formMethod);
  const error =
    data && Object.hasOwn(data, "detail")
      ? (data as { detail: string }).detail
      : "";
  const { job } = state;
  const deleting = job?.status === "tearing_down";
  const active = Boolean(
    job && ["starting", "creating", "waiting", "checking"].includes(job.status),
  );
  const selectionLocked =
    active ||
    deleting ||
    Boolean(job?.podId) ||
    Boolean(job?.uncertain) ||
    job?.status === "teardown_error";
  const models = selectionLocked && job ? job.models : selectedModels;
  useEffect(() => {
    if (data && Object.hasOwn(data, "job")) setState(data as SetupResponse);
  }, [data]);
  useEffect(() => {
    if (fetchState !== "idle") return undefined;
    const timer = setTimeout(() => load("/runpod-config"), 3000);
    return () => clearTimeout(timer);
  }, [load, fetchState, data]);
  function submitSetup(teardown = false): void {
    const form = new FormData();
    models.forEach((id) => form.append("models", id));
    fetcher.submit(teardown ? null : form, {
      method: teardown ? "DELETE" : "POST",
      action: teardown
        ? `/runpod-config?jobId=${encodeURIComponent(job?.id ?? "")}`
        : "/runpod-config",
    });
  }
  return (
    <main className={styles.page} aria-labelledby="runpod-heading">
      <div className={styles.runpodToolbar}>
        <h1 id="runpod-heading">Runpod</h1>
        <button
          type="button"
          className={styles.primary}
          disabled={
            !state.configured ||
            models.length === 0 ||
            pending ||
            active ||
            deleting ||
            job?.status === "teardown_error"
          }
          onClick={() => {
            submitSetup();
          }}>
          {deleting
            ? "Tearing down…"
            : pending || active
              ? job?.podId
                ? "Checking availability…"
                : "Setting up…"
              : job?.podId
                ? "Check availability"
                : job?.podId || job?.uncertain
                  ? "Check setup"
                  : "Set up GPU"}
        </button>
        {job && (
          <button
            type="button"
            disabled={pending || deleting}
            title="Permanently delete this pod and all files on its container disk"
            onClick={() => {
              submitSetup(true);
            }}>
            {deleting
              ? "Tearing down…"
              : job.status === "teardown_error"
                ? "Retry teardown"
                : "Tear down GPU"}
          </button>
        )}
      </div>
      {!selectionLocked && !pending && (
        <fieldset className={styles.models}>
          <legend>Models to install</legend>
          {modelIds.map((id) => (
            <label key={id}>
              <input
                type="checkbox"
                name="models"
                value={id}
                checked={models.includes(id)}
                onChange={(event) => {
                  setSelectedModels((previous) =>
                    event.target.checked
                      ? [...previous, id]
                      : previous.filter((model) => model !== id),
                  );
                }}
              />
              {modelRequirements[id].label}
            </label>
          ))}
          <p>
            {models.length
              ? `${requiredModelFiles(models).length} required files; shared components download once.`
              : "Choose at least one model."}
          </p>
        </fieldset>
      )}
      {job && (
        <p>
          Teardown permanently deletes this pod and all its container files.
        </p>
      )}
      <p>
        RTX 6000 Ada → L40 → A40 → L40S · ComfyUI ·{" "}
        {job ? job.diskGb : modelDiskGb(models)} GB container disk · No attached
        volumes
      </p>
      {!state.configured && (
        <p>
          Set RUNPOD_API_KEY and CIVITAI_KEY in the local .env file to enable
          setup.
        </p>
      )}
      {job && (
        <>
          <output>{job.message}</output>
          {(active || deleting) && (
            <progress aria-label="Runpod operation progress" />
          )}
          {job.comfyStage && (
            <p>ComfyUI: {comfyStageLabels[job.comfyStage]}</p>
          )}
          {Boolean(job.downloads?.length) && (
            <ul className={styles.downloads} aria-label="Model downloads">
              {job.downloads?.map((download) => {
                const ready = download.status === "ready";
                const failed = download.status === "error";
                const paused =
                  failed ||
                  job.status === "error" ||
                  deleting ||
                  job.status === "teardown_error";
                const fraction = ready
                  ? 1
                  : download.total > 0
                    ? Math.min(download.bytes / download.total, 1)
                    : undefined;
                return (
                  <li key={download.name}>
                    <label>
                      <span>{download.name}</span>
                      <progress
                        aria-label={download.name}
                        max={1}
                        value={
                          fraction ??
                          (paused || download.status === "queued"
                            ? 0
                            : undefined)
                        }
                      />
                    </label>
                    <span className={styles.downloadDetail}>
                      {ready
                        ? "Ready"
                        : failed
                          ? "Failed"
                          : download.status === "validating"
                            ? "Validating…"
                            : download.status === "queued"
                              ? "Waiting for download progress…"
                              : "Downloading…"}
                      {download.bytes > 0 && ` · ${sizeLabel(download.bytes)}`}
                      {!ready &&
                        download.total > 0 &&
                        ` / ${sizeLabel(download.total)} (${Math.floor((fraction ?? 0) * 100)}%)`}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
          {job.progressNotice && <output>{job.progressNotice}</output>}
          {job.podId && (
            <p>
              Pod ID: <code>{job.podId}</code>
              {" · "}
              <a
                href="https://console.runpod.io/pods"
                target="_blank"
                rel="noreferrer">
                Manage pod ↗
              </a>
            </p>
          )}
          {job.status === "ready" && job.url && (
            <p>
              Service URL:{" "}
              <a href={job.url} target="_blank" rel="noreferrer">
                {job.url}
              </a>
            </p>
          )}
        </>
      )}
      {error && <p role="alert">{error}</p>}
    </main>
  );
}
