#!/usr/bin/env python3
"""Start prepared ComfyUI and download Antigone's model weights.

Run inside a Runpod ComfyUI container. Use --download-only if ComfyUI is
already running. Requires curl, safetensors, CIVITAI_KEY, and optional HF_TOKEN.
"""

import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import threading
import time
from urllib.error import URLError
from urllib.request import urlopen

ROOT = Path("/workspace/runpod-slim/ComfyUI/models")
COMFYUI_VERSION = "v0.38.0"
DOWNLOADS = [
    (
        "https://civitai.com/api/download/models/2967967",
        "diffusion_models/snofs-klein-9b-base.safetensors",
        "CIVITAI_KEY",
    ),
    (
        "https://huggingface.co/Comfy-Org/flux2-klein-9B/resolve/main/split_files/text_encoders/qwen_3_8b.safetensors",
        "text_encoders/qwen_3_8b.safetensors",
        "HF_TOKEN",
    ),
    (
        "https://huggingface.co/Comfy-Org/flux2-klein-9B/resolve/main/split_files/vae/flux2-vae.safetensors",
        "vae/flux2-vae.safetensors",
        "HF_TOKEN",
    ),
    (
        "https://civitai.com/api/download/models/3372040?fileId=3260162",
        "diffusion_models/noct-q-v4-base.safetensors",
        "CIVITAI_KEY",
    ),
    (
        "https://huggingface.co/Comfy-Org/Qwen-Image-2.1/resolve/main/text_encoders/qwen3vl_8b_int8_convrot.safetensors",
        "text_encoders/qwen3vl_8b_int8_convrot.safetensors",
        "HF_TOKEN",
    ),
    (
        "https://huggingface.co/Comfy-Org/Qwen-Image-2.1/resolve/main/vae/qwen_image_2.1_vae_bf16.safetensors",
        "vae/qwen_image_2.1_vae_bf16.safetensors",
        "HF_TOKEN",
    ),
    (
        "https://huggingface.co/Comfy-Org/Qwen-Image-2.1/resolve/main/diffusion_models/qwen_image_2.1_int8_convrot.safetensors",
        "diffusion_models/qwen_image_2.1_int8_convrot.safetensors",
        "HF_TOKEN",
    ),
    (
        "https://civitai.com/api/download/models/3357315?fileId=3244894",
        "loras/thesealpacas-nsfw-qwen21-v2.safetensors",
        "CIVITAI_KEY",
    ),
]
QWEN_SHARED = {
    "qwen3vl_8b_int8_convrot.safetensors",
    "qwen_image_2.1_vae_bf16.safetensors",
}
MODEL_FILES = {
    "snofs": {
        "snofs-klein-9b-base.safetensors",
        "qwen_3_8b.safetensors",
        "flux2-vae.safetensors",
    },
    "noct-q": QWEN_SHARED | {"noct-q-v4-base.safetensors"},
    "qwen-lora": QWEN_SHARED
    | {
        "qwen_image_2.1_int8_convrot.safetensors",
        "thesealpacas-nsfw-qwen21-v2.safetensors",
    },
}
LOG_LOCK = threading.Lock()


def log(message):
    for name in ("CIVITAI_KEY", "HF_TOKEN"):
        token = os.environ.get(name, "").strip()
        if token:
            message = message.replace(token, "[redacted]")
    with LOG_LOCK:
        print(message, flush=True)


def file_size(path):
    try:
        return path.stat().st_size
    except FileNotFoundError:
        return 0


def content_length(headers):
    try:
        lines = headers.read_text(errors="replace").splitlines()
    except FileNotFoundError:
        return 0
    total = 0
    for line in lines:
        if line.upper().startswith("HTTP/"):
            total = 0
        key, separator, value = line.partition(":")
        if separator and key.lower() == "content-length" and value.strip().isdigit():
            total = int(value.strip())
    return total


def report(destination, status):
    partial = destination.with_name(destination.name + ".partial")
    headers = destination.with_name(destination.name + ".headers")
    size = file_size(destination) if status == "ready" else file_size(partial)
    total = size if status == "ready" else content_length(headers)
    log(f"ANTIGONE_DOWNLOAD {destination.name} {status} {size} {total}")


def stop_process(process):
    if process.poll() is not None:
        return
    process.terminate()
    try:
        process.wait(timeout=10)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait()


def require_prepared_image():
    prepared = Path("/opt/antigone-comfyui-version")
    if not prepared.is_file() or prepared.read_text().strip() != COMFYUI_VERSION:
        raise RuntimeError(
            f"Use a GPU image prepared for ComfyUI {COMFYUI_VERSION}; "
            "rebuild the image with runpod-image/prepare.py"
        )
    log(f"Using preinstalled ComfyUI {COMFYUI_VERSION}")


def check_comfy_nodes(models):
    with urlopen("http://127.0.0.1:8188/object_info", timeout=30) as response:
        nodes = json.load(response)
    required = set()
    types = set()
    samplers = set()
    schedulers = set()
    if "snofs" in models:
        required.update(
            {"EmptyFlux2LatentImage", "ReferenceLatent", "ImageScaleToTotalPixels"}
        )
        types.add("flux2")
    if {"noct-q", "qwen-lora"}.intersection(models):
        required.update(
            {
                "TextEncodeQwenImage21",
                "EmptyLatentImage",
                "ImageScale",
                "RepeatLatentBatch",
            }
        )
        types.add("qwen_image")
    if "qwen-lora" in models:
        required.add("LoraLoader")
        samplers.add("er_sde")
        schedulers.add("beta")
    if {"snofs", "noct-q"}.intersection(models):
        samplers.add("euler")
        schedulers.add("simple")
    missing = required.difference(nodes)
    if missing:
        raise RuntimeError(
            "ComfyUI is missing required nodes: " + ", ".join(sorted(missing))
        )
    for node, field, expected in [
        ("CLIPLoader", "type", types),
        ("KSampler", "sampler_name", samplers),
        ("KSampler", "scheduler", schedulers),
    ]:
        available = (
            nodes.get(node, {}).get("input", {}).get("required", {}).get(field, [[]])[0]
        )
        if not expected.issubset(available):
            raise RuntimeError(
                f"ComfyUI is missing required {field}: "
                + ", ".join(sorted(expected.difference(available)))
            )


def download(url, relative_path, token_name, stopped, comfy_ready):
    # Keep downloads outside the workspace installation while /start.sh copies
    # or upgrades it. Only publish validated files after startup has finished.
    destination = Path("/workspace/antigone-downloads") / relative_path
    partial = destination.with_name(destination.name + ".partial")
    headers = destination.with_name(destination.name + ".headers")
    process = None
    try:
        destination.parent.mkdir(parents=True, exist_ok=True)
        if stopped.is_set():
            raise RuntimeError("Setup interrupted")
        command = [
            "curl",
            "--fail",
            "--silent",
            "--show-error",
            "--location",
            "--retry",
            "2",
            "--connect-timeout",
            "30",
            "--max-time",
            "3600",
            "--dump-header",
            str(headers),
            "-o",
            str(partial),
        ]
        token = os.environ.get(token_name, "").strip()
        if token:
            command.extend(["-H", f"Authorization: Bearer {token}"])
        command.append(url)
        process = subprocess.Popen(command)
        while process.poll() is None:
            report(destination, "downloading")
            if stopped.wait(5):
                raise RuntimeError("Setup interrupted")
        if process.returncode:
            raise RuntimeError(f"Download failed (curl exit {process.returncode})")
        if stopped.is_set():
            raise RuntimeError("Setup interrupted")
        report(destination, "validating")
        while not comfy_ready.wait(1):
            if stopped.is_set():
                raise RuntimeError("Setup interrupted")
        if stopped.is_set():
            raise RuntimeError("Setup interrupted")
        from safetensors import safe_open

        with safe_open(str(partial), framework="pt", device="cpu") as weights:
            if not list(weights.keys()):
                raise RuntimeError("Empty weights")
        if stopped.is_set():
            raise RuntimeError("Setup interrupted")
        installed = ROOT / relative_path
        installed.parent.mkdir(parents=True, exist_ok=True)
        partial.replace(installed)
        report(installed, "ready")
    except Exception as error:
        report(destination, "error")
        log(f"Download failed for {destination.name}: {error}")
        raise
    finally:
        if process is not None:
            stop_process(process)
        headers.unlink(missing_ok=True)


def wait_for_comfy(service, stopped):
    deadline = time.monotonic() + 15 * 60
    while time.monotonic() < deadline:
        log("ANTIGONE_COMFYUI starting")
        if stopped.is_set():
            raise RuntimeError("Setup interrupted")
        if service is not None and service.poll() is not None:
            raise RuntimeError("ComfyUI startup process exited")
        try:
            with urlopen("http://127.0.0.1:8188/system_stats", timeout=5) as response:
                if response.status == 200:
                    return
        except (URLError, TimeoutError, OSError):
            pass
        stopped.wait(5)
    raise RuntimeError("ComfyUI did not start within 15 minutes")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--download-only", action="store_true")
    parser.add_argument("--models", nargs="+", choices=sorted(MODEL_FILES))
    args = parser.parse_args()
    models = (
        args.models
        if args.models is not None
        else [
            model.strip()
            for model in os.environ.get("ANTIGONE_MODELS", "noct-q,qwen-lora").split(
                ","
            )
        ]
    )
    if not models or not set(models).issubset(MODEL_FILES):
        parser.error("Select at least one of noct-q, qwen-lora, or snofs")
    required_files = set().union(*(MODEL_FILES[model] for model in models))
    downloads = [item for item in DOWNLOADS if Path(item[1]).name in required_files]
    stopped = threading.Event()
    comfy_ready = threading.Event()
    service = None

    def shutdown(signum, _frame):
        stopped.set()
        if service is not None:
            try:
                os.killpg(service.pid, signum)
            except ProcessLookupError:
                pass

    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)
    failed = False
    try:
        if not os.environ.get("CIVITAI_KEY", "").strip():
            raise RuntimeError("Set CIVITAI_KEY before running setup")
        if not args.download_only:
            require_prepared_image()
        with ThreadPoolExecutor(max_workers=len(downloads)) as executor:
            futures = [
                executor.submit(download, *item, stopped, comfy_ready)
                for item in downloads
            ]
            try:
                if not args.download_only:
                    service = subprocess.Popen(["/start.sh"], start_new_session=True)
                wait_for_comfy(service, stopped)
                log("ANTIGONE_COMFYUI checking")
                check_comfy_nodes(models)
                log("ANTIGONE_COMFYUI ready")
            except Exception:
                log("ANTIGONE_COMFYUI error")
                stopped.set()
                raise
            finally:
                comfy_ready.set()
            for future in as_completed(futures):
                try:
                    future.result()
                except Exception:
                    failed = True
        if failed:
            log("ANTIGONE_SETUP_FAILED: model setup failed; inspect pod logs")
        else:
            log("ANTIGONE_SETUP_READY")
    except Exception as error:
        failed = True
        log("ANTIGONE_COMFYUI error")
        log(f"ANTIGONE_SETUP_FAILED: {error}")
    # Leave ComfyUI running for inspection even when a download fails.
    if service is not None:
        while service.poll() is None:
            if stopped.wait(1):
                try:
                    service.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    try:
                        os.killpg(service.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                    service.wait()
                break
        if failed:
            return 1
        return (
            service.returncode if service.returncode >= 0 else 128 - service.returncode
        )
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
