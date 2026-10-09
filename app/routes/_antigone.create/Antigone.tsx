import type { ReactElement } from "react";
import { useGenerationContext } from "./useGeneration";
import GenerationForm from "./GenerationForm";
import GenerationResult from "./GenerationResult";

import styles from "./Antigone.module.css";

export default function Antigone(): ReactElement {
  const { images, error, submitting, retryJob, generate, jobs, removeQueued } =
    useGenerationContext();
  const groups = [
    {
      title: "Queue",
      description:
        "Jobs run in order. Downloads continue while the next job generates. Jobs keep running on the server after you close this tab.",
      entries: jobs.filter(
        (job) => job.phase !== "complete" && job.phase !== "failed",
      ),
    },
    {
      title: "Failed jobs",
      description:
        "These jobs keep their inputs and can be retried later. They do not block the queue.",
      entries: jobs.filter((job) => job.phase === "failed"),
    },
  ];
  return (
    <main className={styles.antigone}>
      <GenerationForm submitting={submitting} onGenerate={generate} />
      {groups
        .filter((group) => group.entries.length > 0)
        .map((group) => (
          <section
            key={group.title}
            aria-label={group.title}
            className={styles.queue}>
            <h2>{group.title}</h2>
            <p>{group.description}</p>
            <div className={styles.tableScroll}>
              <table className={styles.queueTable}>
                <thead>
                  <tr>
                    <th scope="col">Prompt</th>
                    <th scope="col">Model ID</th>
                    <th scope="col">Reference images</th>
                    <th scope="col">Status</th>
                    <th scope="col">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {group.entries.map((job) => (
                    <tr key={job.id}>
                      <td>
                        <span
                          className={styles.jobPrompt}
                          title={job.input.prompt}>
                          {job.input.prompt}
                        </span>
                      </td>
                      <td>
                        <code>{job.input.model}</code>
                      </td>
                      <td>
                        {job.input.sourceImages.length ? (
                          <div className={styles.references}>
                            {job.input.sourceImages.map((image, index) => (
                              <a
                                key={image.id}
                                href={image.url}
                                target="_blank"
                                rel="noreferrer"
                                title={image.name}>
                                <img
                                  src={image.url}
                                  alt={`Reference ${index + 1}: ${image.name}`}
                                  loading="lazy"
                                />
                              </a>
                            ))}
                          </div>
                        ) : (
                          "None"
                        )}
                      </td>
                      <td>
                        <div className={styles.jobProgress}>
                          {(job.phase === "generating" ||
                            job.phase === "downloading") && (
                            <progress
                              aria-label={
                                job.sampling
                                  ? "Sampling progress"
                                  : "Job progress"
                              }
                              aria-describedby={`status-${job.id}`}
                              max={job.sampling?.max ?? 1}
                              value={job.sampling?.value}
                            />
                          )}
                          <span id={`status-${job.id}`}>
                            {job.status}
                            {job.sampling &&
                              ` · ${job.sampling.value}/${job.sampling.max} (${Math.round((job.sampling.value / job.sampling.max) * 100)}%)`}
                          </span>
                        </div>
                      </td>
                      <td>
                        <div className={styles.jobActions}>
                          {job.phase === "failed" && (
                            <button
                              type="button"
                              onClick={() => {
                                void retryJob(job.id);
                              }}>
                              Retry
                            </button>
                          )}
                          {(job.phase === "queued" ||
                            job.phase === "failed") && (
                            <button
                              type="button"
                              onClick={() => {
                                void removeQueued(job.id);
                              }}>
                              Remove
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        ))}
      {error && <output role="alert">{error}</output>}
      <GenerationResult images={images} />
    </main>
  );
}
