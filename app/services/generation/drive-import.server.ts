export async function readLimitedBody(
  response: Response | Request,
  limit: number,
): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) throw Error("No image data was received");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.length;
      if (size > limit) throw Error("The upload exceeds the size limit");
      chunks.push(next.value);
    }
    return Buffer.concat(chunks);
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
export function imageType(bytes: Uint8Array): string | null {
  const data = Buffer.from(bytes);
  if (
    data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return "image/png";
  if (data[0] === 255 && data[1] === 216 && data[2] === 255)
    return "image/jpeg";
  if (
    data.toString("ascii", 0, 4) === "RIFF" &&
    data.toString("ascii", 8, 12) === "WEBP"
  )
    return "image/webp";
  return null;
}
export async function importDriveImage(
  link: string,
  signal: AbortSignal,
): Promise<{ bytes: Uint8Array; type: string; name: string }> {
  const source = URL.parse(link.trim());
  if (!source) throw Error("Paste a Google Drive file link");
  if (
    source.protocol !== "https:" ||
    source.hostname !== "drive.google.com" ||
    source.username ||
    source.password ||
    source.port
  )
    throw Error("Paste an HTTPS Google Drive file link");
  const match = /^\/file\/d\/(?<id>[\w-]+)(?:\/|$)/u.exec(source.pathname);
  const id =
    match?.groups?.id ??
    (["/open", "/uc"].includes(source.pathname)
      ? source.searchParams.get("id")
      : null);
  if (!id || !/^[\w-]{10,200}$/u.test(id))
    throw Error("Use a link to an individual Drive image, not a folder");
  let url = new URL("https://drive.usercontent.google.com/download");
  url.searchParams.set("id", id);
  url.searchParams.set("export", "download");
  url.searchParams.set("confirm", "t");
  const resourceKey = source.searchParams.get("resourcekey");
  if (resourceKey) {
    if (!/^[\w-]{1,200}$/u.test(resourceKey))
      throw Error("Invalid Drive resource key");
    url.searchParams.set("resourcekey", resourceKey);
  }
  const timeout = AbortSignal.any([signal, AbortSignal.timeout(60000)]);
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    // Fetch only Google's download hosts, including every redirect.
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.port ||
      !(
        [
          "drive.google.com",
          "drive.usercontent.google.com",
          "docs.google.com",
        ].includes(url.hostname) ||
        url.hostname.endsWith(".googleusercontent.com")
      )
    ) {
      throw Error(
        "Drive requires sign-in or returned an unsupported download link. Enable anyone-with-the-link access.",
      );
    }
    const response = await fetch(url, { redirect: "manual", signal: timeout });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      const location = response.headers.get("Location");
      if (!location) throw Error("Drive returned an invalid download link");
      url = new URL(location, url);
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw Error(
        "Drive could not download this file. Check link sharing, download permissions, and the download quota.",
      );
    }
    const bytes = await readLimitedBody(response, 20 * 1024 * 1024);
    const type = imageType(bytes);
    if (!type) {
      throw Error(
        "Drive did not return a PNG, JPEG, or WebP image. The file must be downloadable without signing in.",
      );
    }
    const extension =
      type === "image/jpeg" ? "jpg" : type === "image/webp" ? "webp" : "png";
    return { bytes, type, name: `drive-${id}.${extension}` };
  }
  throw Error("Drive redirected too many times");
}
