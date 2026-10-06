#!/usr/bin/env python3
"""Install the pinned ComfyUI release while building the distributed GPU image."""

from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tempfile

COMFYUI_VERSION = "v0.38.0"


def main():
    baked = Path("/opt/comfyui-baked")
    constraints = Path("/opt/comfyui-runtime-constraints.txt")
    if not baked.is_dir() or not constraints.is_file():
        raise RuntimeError("Expected the official ComfyUI CUDA template layout")
    prepared = Path("/opt/antigone-comfyui-version")
    if prepared.is_file() and prepared.read_text().strip() == COMFYUI_VERSION:
        print(f"Using preinstalled ComfyUI {COMFYUI_VERSION}")
        return
    print(f"Upgrading ComfyUI to {COMFYUI_VERSION} during image build…")
    with tempfile.TemporaryDirectory(prefix="antigone-comfyui-") as directory:
        archive = Path(directory) / "comfyui.tar.gz"
        subprocess.run(
            [
                "curl",
                "--fail",
                "--location",
                "--retry",
                "2",
                "--connect-timeout",
                "30",
                "--max-time",
                "600",
                "-o",
                str(archive),
                f"https://github.com/Comfy-Org/ComfyUI/archive/refs/tags/{COMFYUI_VERSION}.tar.gz",
            ],
            check=True,
        )
        with tarfile.open(archive) as source:
            source.extractall(directory, filter="data")
        source = Path(directory) / f"ComfyUI-{COMFYUI_VERSION.removeprefix('v')}"
        # Preserve the template's custom nodes and bundle manifest. /start.sh
        # copies this upgraded bundle into the workspace before launching it.
        shutil.copytree(source, baked, dirs_exist_ok=True)
    subprocess.run(
        [
            sys.executable,
            "-m",
            "pip",
            "install",
            "--no-cache-dir",
            "--constraint",
            str(constraints),
            "-r",
            str(baked / "requirements.txt"),
        ],
        check=True,
    )
    manifest = baked / ".runpod-bundle-version"
    marker = f"ANTIGONE_COMFYUI_VERSION={COMFYUI_VERSION}"
    # Some official image versions ship the bundle without a manifest.
    try:
        existing = manifest.read_text()
    except FileNotFoundError:
        existing = ""
    lines = [
        line
        for line in existing.splitlines()
        if not line.startswith("ANTIGONE_COMFYUI_VERSION=")
    ]
    temporary_manifest = manifest.with_name(manifest.name + ".tmp")
    temporary_manifest.write_text("\n".join([*lines, marker]) + "\n")
    temporary_manifest.replace(manifest)
    print(f"ComfyUI {COMFYUI_VERSION} and dependencies installed")
    prepared.write_text(COMFYUI_VERSION + "\n")



if __name__ == "__main__":
    main()
