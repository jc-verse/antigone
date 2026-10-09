# Antigone

Antigone is a self-hosted image generation interface.

Image generation uses the ready Runpod GPU configured on the Runpod page and takes a prompt and optional PNG/JPEG/WebP uploads (up to 20 MiB each). Under Input images, paste a Google Drive file link to import it automatically, or use Import image for a typed link. Shared files must be downloadable without Google sign-in. The server preserves link resource keys, restricts redirects to Google download hosts, enforces the size limit, and checks image signatures. Private, blocked, quota-limited, folder, and non-image links show an error without adding an attachment.

Unsubmitted file uploads and Drive imports are held in temporary server memory and displayed through authenticated, non-cached server URLs. They expire after 24 hours or a server restart; enqueueing snapshots them into durable job storage. Add to queue sends only the prompt, settings, and server image IDs. The server snapshots the referenced images and submits all GPU requests itself. The server accepts jobs even without a configured or ready GPU and commits each job and its image bytes to SQLite before acknowledging it. Jobs remain queued until the configured GPU is ready; only then does the worker dequeue them. A background worker processes jobs in FIFO order and starts the next GPU request as soon as the current job's GPU work finishes, while its outputs are still downloading. Browser navigation, reload, and closing the tab do not stop accepted jobs. The browser receives queue and library updates through `/api/queue` using SSE. Committed job changes push a fresh snapshot; connections receive an initial snapshot, heartbeat comments, automatic reconnection, and a fresh snapshot after reconnecting. Disconnecting releases the subscription without stopping server jobs. ComfyUI progress still comes from a per-job WebSocket. Failed jobs appear in a separate table, retain their inputs, and offer Retry or Remove. Pending jobs resume when the server starts and the configured GPU is ready. When a ready GPU lacks a queued job’s model, that job moves to Failed jobs with its inputs preserved and the worker proceeds to the next compatible job. It can be retried after setting up the required model. With no ready GPU, jobs remain queued. Jobs interrupted by a server restart are marked failed for explicit retry, since blindly rerunning an unknown GPU request can duplicate work.

Authentication, GPU setup, the queue, and the library (including all input and output image bytes) share one database at `/data/antigone.sqlite3` on the persistent Compose volume. The worker assumes one Antigone server process. `/library` lists completed generations with their prompt, resolved model/settings, downloadable inputs and outputs, and per-entry deletion. Image routes require Antigone authentication. All signed-in browsers see the same server library and queue.

Generation data is stored on the server. Unsaved prompt/settings edits exist only in the current form; input attachments and output previews are not restored after a refresh. The generation page only previews outputs for jobs submitted or retried in the current browser session; completed jobs remain available in the library. Removing an attachment does not remove the copies in queued jobs or library entries. Klein uses reference-guided editing at full denoise. Aspect presets and custom width/height apply with or without an input image, accepting 64–2048 pixels per side: multiples of 32 for Noct Q and Qwen 2.1 + LoRA, and multiples of 16 for SNOFS. SNOFS reference images are scaled to approximately one megapixel with their aspect ratio retained, independently of output dimensions. Noct Q and Qwen 2.1 + LoRA reference images are resized and center-cropped to the output dimensions. Runpod setup and teardown are available from the header’s settings dropdown.

The TypeScript client can also run independently: `bun app/services/generation/runpod_client.ts --url URL --prompt TEXT --image photo.jpg --out result.png`. Use `--out -` to write PNG bytes to stdout. It exports `generateImages` for Antigone and requires no Python runtime.

Routes: `/` (redirect), `/create`, `/library`, `/runpod-config`, `/api/image` (enqueue), `/api/queue`, `/api/asset`, `/api/job` (delete), `/api/retry`, `/api/drive`, `/api/upload`, `/auth/login`, `/auth/logout`, `/auth/onboard`, and `/auth/manage`. Run Antigone with Docker Compose. Configure `APP_ORIGIN` in `.env`; the container stores all application data under `/data`.

The form shows a progress bar only while uploading attachments, importing a Drive image, or submitting a job; it stops when the server accepts the request. The queue table shows each job’s prompt, model ID, reference thumbnails, and status. Generating and downloading jobs have their own progress bar beside the status, with sampling steps and percentages when ComfyUI reports them. Queued, completed, and failed jobs have no animated bar. Each request opens its own WebSocket before submitting the prompt and filters messages by prompt ID; history polling still retrieves the output if live progress is unavailable.

## Runpod setup

The **Set up GPU** button creates a pod directly from the container image selected by `RUNPOD_IMAGE`, trying NVIDIA RTX 6000 Ada Generation, then NVIDIA L40, then NVIDIA A40, then NVIDIA L40S in Secure Cloud. Antigone queries current CUDA 13-or-newer host availability for each candidate and requests a container disk sized from the selected model files: `ceil((unique model bytes / 1e9 + 8) / 5) * 5` GB, with no persistent or network volume. Shared components count once; the disk includes at least 8 GB of headroom and rounds up to a multiple of 5 GB. Choose the models to install with the setup checkboxes; Noct Q and Qwen + LoRA are checked by default, and at least one is required. The selection is saved with the pod and can be changed by tearing it down and creating a new one. The prepared ComfyUI installation starts while the selected models’ required files download concurrently from Civitai and Hugging Face. Each download uses a temporary filename, validates the safetensors file, and renames it only after success. The Runpod page shows per-file downloaded bytes, percentages when the server supplies a content length, and validation/failure status. Antigone reads structured progress from the authenticated Runpod log stream; the frontend receives it through the existing status polling. Progress reconnects independently of readiness checks.

Set `RUNPOD_API_KEY` and `CIVITAI_KEY` in the local `.env` file. Compose loads this file into Antigone only. The Runpod key stays on the app server; the Civitai key is passed to the GPU pod. Neither key is returned to the browser. Optionally set `HF_TOKEN` for authenticated Hugging Face downloads. Only Hugging Face requests use this token, and it is redacted from setup errors. Recreate the app container after changing credentials; existing GPU pods do not receive updated environment variables.

Setup runs in the background, with state stored in `/data/antigone.sqlite3` so refreshing the page does not interrupt it. The `/runpod-config` route provides the page, authenticated status polling, setup, and teardown through its loader and action. The frontend displays the pod ID immediately after creation and reports readiness when ComfyUI lists the selected models’ files and required workflow nodes. Noct Q and Qwen + LoRA share their text encoder and VAE, so the default selection downloads five files; selecting all three models downloads eight. **Check availability** checks the recorded pod, model files, and workflow nodes without provisioning a replacement. Tear down the recorded pod before setting up another. Ambiguous creation failures are reconciled by the unique pod name instead of blindly creating another resource. Setup errors leave the pod ID visible for inspection and termination in Runpod. Pods are not automatically terminated; container-only model storage is disposable.

The prepared GPU image is `ghcr.io/jc-verse/antigone-comfyui:v0.38.0-1`. It is public and can be pulled without registry credentials: leave `GHCR_USERNAME` and `GHCR_TOKEN` empty. For a private alternative, set both fields in `.env`; Antigone registers the credentials with Runpod and supplies the resulting registry ID when creating a pod. Credentials are never passed into the GPU container. `RUNPOD_IMAGE` is optional: unset, empty, or whitespace-only values use the public image above. Set it to another compatible image to override the default. Antigone sends the image directly to Runpod together with the GPU, disk size, ports, bootstrap command, and environment determined at provisioning time. No Runpod template is required. The image must support the bundled ComfyUI bootstrap and model layout.

The same setup is runnable with `bun app/services/runpod/runpod_provisioner.ts` (defaulting to Noct Q and Qwen + LoRA), using `RUNPOD_API_KEY` and `CIVITAI_KEY` from the process environment. Set `ANTIGONE_MODELS` to a comma-separated selection of `noct-q`, `qwen-lora`, and `snofs` to override the CLI defaults. It writes status to stderr and the created pod ID to stdout, exiting nonzero if setup fails.

The Runpod panel also offers **Tear down GPU**. It permanently deletes the recorded pod and its container disk, then clears the backend setup record. Generation derives its GPU URL from that record. Teardown can cancel ongoing setup; failures retain the record for retry.

Choose 1, 2, 4, or 8 output images. Antigone requests them as one ComfyUI batch; GPU out-of-memory failures halve the batch size and retry the remaining images in smaller batches. A batch of one that still runs out of memory reports an error. Each output has its own download link. Each complete set is added to the library only after every image arrives successfully. The standalone client accepts `--count 1|2|4|8` and writes numbered PNG files for multiple outputs; standard output supports one image only.

Image preparation lives in `runpod-image/prepare.py` and runs only during the GPU image build. It installs ComfyUI v0.38.0 and dependencies under the base image's CUDA PyTorch constraints, then records the prepared version. It does not download model weights or start ComfyUI.

Pod startup and parallel model downloads live in `app/services/runpod/runpod_bootstrap.py`. This script validates the prepared image, starts ComfyUI via `/start.sh`, checks required nodes, and downloads and validates the selected weights. It never installs or upgrades ComfyUI; incompatible images must be rebuilt. Antigone sends this script to each new pod and imports it as text with Vite’s `?raw` asset handling, embedding it in the server bundle. Run it inside a prepared ComfyUI container with `python3 -u runpod_bootstrap.py`, or use `--download-only` when a compatible ComfyUI instance is already running. It accepts `--models noct-q qwen-lora` (or `ANTIGONE_MODELS`) and uses the container's curl and safetensors installations, with `CIVITAI_KEY` and optional `HF_TOKEN`. Model downloads are staged separately and moved into the model directories after startup and validation.

The web model selector defaults to **Auto** and shows only models selected for the current GPU setup. With input images, Auto prefers SNOFS, then Noct Q, then Qwen + LoRA; without inputs it prefers Noct Q, then Qwen + LoRA, then SNOFS. Setup changes update the selector through SSE. Models selected for an in-progress setup remain selectable so jobs can queue before readiness; with no setup, the default Noct Q + Qwen selection is used. The server validates availability and uses the same priorities for Auto submissions. The resolved model is saved with each job and is not changed later if the pod changes. Noct Q and Qwen 2.1 + LoRA edits resize and center-crop the reference to the requested output dimensions, then repeat the reference-sized latent for batching. Dimensions must be multiples of 32 for Noct Q and Qwen 2.1 + LoRA, and 16 for SNOFS. The standalone client supports `--model auto|noct-q|qwen-lora|snofs`.

**Qwen 2.1 + LoRA** (`qwen-lora`) uses the official INT8 convrot diffusion weights, the shared Qwen text encoder and VAE, and the TheseAlpacas Qwen 2.1 v2 LoRA at strength 0.8. It uses the `er_sde` sampler, `beta` scheduler, and CFG 4. The web form’s Steps value applies; the standalone client defaults to 28 steps when omitted.

## Standalone project

Authentication and UI components live alongside the generation code in `app/`. Server and build configuration live at the project root. This project has one package, lockfile, and set of development tools. Run `bun run typecheck`, `bun run lint`, or `bun run build` here.

`compose.yaml` builds the app with the local `Dockerfile`, publishes its HTTP port, and mounts the persistent data volume.

### Docker configuration

Keep all configuration and secrets in a local `.env` file. For a new installation, copy `.env.example` to `.env` and fill in your values. Set `INIT_PASSWORD` to a random initial password of at least 32 bytes (for example, generate one with `openssl rand -hex 32`). Add the provider tokens before GPU setup. Restrict access with `chmod 600 .env`.

The file is ignored by Git and excluded from Docker builds. Compose injects it into Antigone using `env_file`. No Compose override file is needed. For a direct container invocation, use `docker run --env-file .env` with the appropriate volume and port mappings.

| Setting | Purpose |
| --- | --- |
| `APP_ORIGIN` | Exact browser origin; HTTP allowed only for localhost |
| `INIT_PASSWORD` | Initial password for setting up the owner password and authenticator |
| `BETTER_AUTH_SECRET` | Secret for authentication encryption and signing |
| `RUNPOD_IMAGE` | Optional GPU image override; defaults to `ghcr.io/jc-verse/antigone-comfyui:v0.38.0-1` |
| `RUNPOD_API_KEY` | Runpod provisioning credential |
| `CIVITAI_KEY` | Model download credential |
| `GHCR_USERNAME` | Optional registry account for a private GPU image |
| `GHCR_TOKEN` | Optional registry token; set together with `GHCR_USERNAME` |
| `HF_TOKEN` | Optional authenticated Hugging Face downloads |

After configuring `.env`, run:

```sh
docker compose build
docker compose run --rm --no-deps antigone bun run db:push
docker compose up -d
```

Schema changes are applied manually with `db:push`, never during startup. Back up existing data before any destructive schema change. Sign in with `INIT_PASSWORD` to choose a new password and configure an authenticator, then optionally register a passkey. Subsequent sign-ins use password plus two-factor authentication, or a passkey.

Antigone listens on `0.0.0.0:4410` inside the container. Compose publishes it at `127.0.0.1:4410`; to use another host port, change the mapping, for example `127.0.0.1:8080:4410`, or pass `-p 127.0.0.1:8080:4410` to `docker run`. The port is not configured through `.env`. For local use, set `APP_ORIGIN=http://localhost:4410` and open that exact address (not `127.0.0.1`). If you map another host port, include it in `APP_ORIGIN`. For remote access, point your HTTPS reverse proxy at the published port and set `APP_ORIGIN` to the external HTTPS address. Configure the proxy to preserve the original host and stream queue updates without buffering. Forwarded headers are not trusted; rate limits use the socket address. Persistent data is stored in the `antigone_data` Docker volume. Recreate the app container after changing `.env`; existing GPU pods do not receive updated credentials.

## Container commands

The app image uses `bun link` to register the `antigone-generate` and `antigone-provision` binaries declared in `package.json` on PATH. Run them in a running Compose container:

```sh
docker compose exec antigone antigone-generate --url URL --prompt "A forest" --out /data/result.png
docker compose exec antigone antigone-provision
```

The provision command uses the container's configured environment and creates a billable Runpod pod. You can also run either command in a one-off container with `docker compose run --rm antigone COMMAND`.

The GPU image is built independently from the `runpod-image/` directory and starts ComfyUI through `/start.sh`. Antigone supplies its bootstrap when creating a pod; the image does not bundle application scripts. See [GPU image build instructions](runpod-image/README.md).

## Weight sizes

Measured on 2026-10-06 using Hugging Face LFS metadata and Civitai file metadata (`sizeKB × 1024`). Hugging Face downloads follow `main`; Civitai downloads use pinned model versions. The byte values in `app/services/generation/models.ts` are estimates for disk allocation, not exact-size requirements. A download that exceeds available disk space fails setup.

| File                     |          Bytes |
| ------------------------ | -------------: |
| Noct Q diffusion         | 14,230,280,896 |
| Qwen diffusion           |  7,256,783,064 |
| Shared Qwen text encoder |  9,350,798,360 |
| Shared Qwen VAE          |    675,509,688 |
| Qwen LoRA                |     79,744,352 |
| SNOFS diffusion          | 18,157,185,200 |
| SNOFS text encoder       | 16,381,517,176 |
| SNOFS VAE                |    336,211,292 |

Measurement sources: `Comfy-Org/Qwen-Image-2.1` at `cb504a4090723e43f17ad01cec0359490e2de613`, `Comfy-Org/flux2-klein-9B` at `3f62d9d8ae1fec33c6e91453d5c712855b096b55`. Civitai version/file pairs: Noct Q `3372040/3260162`, SNOFS `2967967/2847831`, LoRA `3357315/3244894`.

| Selected models | Weight size (decimal GB) | Container disk (GB) |
| --- | --: | --: |
| Noct Q | 24.257 | 35 |
| Qwen + LoRA | 17.363 | 30 |
| SNOFS | 34.875 | 45 |
| Noct Q + Qwen + LoRA (default) | 31.593 | 40 |
| Noct Q + SNOFS | 59.132 | 70 |
| Qwen + LoRA + SNOFS | 52.238 | 65 |
| All three | 66.468 | 75 |

Formula: `ceil((unique file bytes / 1e9 + 8) / 5) * 5`. Staged downloads are renamed into place on the same filesystem rather than copied. Update these estimates if model growth causes setup to run out of disk space.

## Docker development

The repository’s Compose file runs the Dockerfile’s `development` target. Start it with `docker compose up --build` and open `http://localhost:4410`. Source files are bind-mounted into the container, while a separate volume holds its Linux dependencies. Dependencies are synchronized from the lockfile at startup.

Vite watches the mounted files using polling and serves hot updates over the same port as the app, including when the host port is remapped. React and CSS changes appear without rebuilding the image. Restart the container after changing `server.ts` or `.env`; rebuild it after changing the Dockerfile.

The default Dockerfile target remains the production runtime. Build it with `docker build -t antigone .` for deployment; it contains the compiled app and does not run Vite.
