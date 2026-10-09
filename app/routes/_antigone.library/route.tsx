import { useEffect, useRef, useState, type ReactElement } from "react";
import { Link } from "@remix-run/react";
import { useGenerationContext } from "../_antigone.create/useGeneration";
import GenerationResult from "../_antigone.create/GenerationResult";
import styles from "./Library.module.css";

export default function Library(): ReactElement {
  const { jobs, loading, error, removeQueued } = useGenerationContext();
  const entries = jobs
    .filter((job) => job.phase === "complete")
    .sort((a, b) => b.createdAt - a.createdAt);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const selected = entries.find((entry) => entry.id === selectedId);
  const openId = selected?.id;
  useEffect(() => {
    if (openId) dialog.current?.showModal();
    else dialog.current?.close();
  }, [openId]);
  useEffect(() => {
    const element = dialog.current;
    if (!element) return undefined;
    function closeOnBackdrop(event: MouseEvent): void {
      if (!element || event.target !== element) return;
      const bounds = element.getBoundingClientRect();
      if (
        event.clientX < bounds.left ||
        event.clientX > bounds.right ||
        event.clientY < bounds.top ||
        event.clientY > bounds.bottom
      )
        element.close();
    }
    element.addEventListener("click", closeOnBackdrop);
    return () => element.removeEventListener("click", closeOnBackdrop);
  }, []);
  return (
    <main className={styles.library}>
      <h1>Library</h1>
      <p>
        Inputs, prompts, and finished images are saved on the server and
        available from any signed-in browser.
      </p>
      {error && <p role="alert">{error}</p>}
      {loading && <p>Loading library…</p>}
      {!loading && !entries.length && (
        <p>
          No saved generations yet.{" "}
          <Link to="/create">Add a job to the queue.</Link>
        </p>
      )}
      <div className={styles.grid}>
        {entries.map((entry) => (
          <button
            className={styles.preview}
            key={entry.id}
            type="button"
            aria-label={`View generation: ${entry.input.prompt}`}
            aria-haspopup="dialog"
            onClick={() => setSelectedId(entry.id)}>
            <img src={entry.outputs[0]?.url} alt="" loading="lazy" />
          </button>
        ))}
      </div>
      <dialog
        ref={dialog}
        className={styles.dialog}
        aria-labelledby="library-entry-heading"
        onClose={() => setSelectedId(null)}>
        {selected && (
          <>
            <div className={styles.heading}>
              <h2 id="library-entry-heading">Generation details</h2>
              <button type="button" onClick={() => dialog.current?.close()}>
                Close
              </button>
            </div>
            {error && <p role="alert">{error}</p>}
            <div className={styles.heading}>
              <p>{new Date(selected.createdAt).toLocaleString()}</p>
              <button
                type="button"
                onClick={() => {
                  void removeQueued(selected.id);
                }}>
                Delete entry
              </button>
            </div>
            <p className={styles.prompt}>{selected.input.prompt}</p>
            <p>
              {selected.input.model} · {selected.input.width} ×{" "}
              {selected.input.height} · {selected.input.steps} steps ·{" "}
              {selected.outputs.length} output(s)
            </p>
            {selected.input.sourceImages.length > 0 && (
              <details>
                <summary>
                  Input images ({selected.input.sourceImages.length})
                </summary>
                <div className={styles.inputs}>
                  {selected.input.sourceImages.map((image, index) => (
                    <a
                      key={image.id}
                      href={image.url}
                      target="_blank"
                      rel="noreferrer">
                      <img
                        src={image.url}
                        alt={`Input reference ${index + 1}`}
                        loading="lazy"
                      />
                    </a>
                  ))}
                </div>
              </details>
            )}
            <GenerationResult images={selected.outputs.map(({ url }) => url)} />
          </>
        )}
      </dialog>
    </main>
  );
}
