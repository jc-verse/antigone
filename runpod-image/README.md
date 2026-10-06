# Antigone Runpod image

This directory is a standalone Docker build context. It builds ComfyUI v0.38.0 and its dependencies on the digest-pinned official CUDA 13 image. It does nothing other than upgrading ComfyUI at the moment compared to the base ComfyUI template, because some models require the new ComfyUI.

## Building the image

Build from this directory with a new release tag for Runpod's architecture:

```sh
docker buildx build --platform linux/amd64 \
  -t ghcr.io/jc-verse/antigone-comfyui:YOUR_NEW_RELEASE_TAG --push .
```

From the parent directory, use `runpod-image` as the build context instead of `.`.

[The published package is here.](https://github.com/orgs/jc-verse/packages/container/package/antigone-comfyui)

## Running the image

Deploy a GPU pod on Runpod using `ghcr.io/jc-verse/antigone-comfyui:v0.38.0-1` as the container image. The image is public, so no registry credentials are needed.

- Choose a GPU with enough VRAM for your models and a host compatible with CUDA 13.
- Allocate enough disk space for the models, inputs, and generated outputs.
- Expose HTTP port `8188` (`8188/http` in the API).
- Leave the container start command unset to use the image’s default `/start.sh` entrypoint.

Once ComfyUI is ready, open the port 8188 HTTP service from the pod’s Connect panel. Its Runpod proxy URL is `https://<pod-id>-8188.proxy.runpod.net`; the same address serves the ComfyUI API.

The image includes ComfyUI v0.38.0 and its dependencies, but no model weights or download credentials. Install the models required by your workflows into the appropriate ComfyUI model directories. For automated setup, supply a bootstrap command that downloads your models and starts `/start.sh`, passing any required download credentials through the pod’s environment.
