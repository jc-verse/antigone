import type { ReactElement } from "react";

import styles from "./GenerationResult.module.css";

export default function GenerationResult({
  images,
}: {
  readonly images: readonly string[];
}): ReactElement | null {
  if (!images.length) return null;
  return (
    <section className={styles.result} aria-label="Generation results">
      {images.map((image, index) => (
        <div key={image}>
          <div className={styles.resultActions}>
            <a
              href={image}
              download={
                images.length === 1
                  ? "antigone.png"
                  : `antigone-${index + 1}.png`
              }>
              Download image {images.length > 1 ? index + 1 : ""} ↓
            </a>
          </div>
          <img
            src={image}
            alt={`Generated result ${index + 1}`}
            loading="lazy"
          />
        </div>
      ))}
    </section>
  );
}
