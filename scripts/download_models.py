"""Explicitly download pinned GGUF weights and verify their upstream LFS digests."""

import argparse
import hashlib
import os
import urllib.request
from pathlib import Path


MODELS = {
    "chat-2b": (
        "unsloth/Qwen3.5-2B-GGUF", "f6d5376be1edb4d416d56da11e5397a961aca8ae",
        "Qwen3.5-2B-Q4_K_M.gguf",
        "aaf42c8b7c3cab2bf3d69c355048d4a0ee9973d48f16c731c0520ee914699223",
    ),
    "chat-0.8b": (
        "ggml-org/Qwen3.5-0.8B-GGUF", "8fea620810c4afa23dd6443f999a48574c1611a3",
        "Qwen3.5-0.8B-Q4_0.gguf",
        "57d1997790d1744fba5b40a7317df71ea5e2acee28c47e78f0cce39c0703f8cf",
    ),
    "embedding": (
        "Qwen/Qwen3-Embedding-0.6B-GGUF", "370f27d7550e0def9b39c1f16d3fbaa13aa67728",
        "Qwen3-Embedding-0.6B-Q8_0.gguf",
        "06507c7b42688469c4e7298b0a1e16deff06caf291cf0a5b278c308249c3e439",
    ),
}


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def download(name: str, directory: Path) -> None:
    repo, revision, filename, expected = MODELS[name]
    directory.mkdir(parents=True, exist_ok=True)
    target = directory / filename
    if target.exists():
        if sha256(target) != expected:
            raise ValueError(f"Existing {target} has the wrong SHA-256; inspect it before retrying")
        print(f"Verified {target}")
        return
    temporary = target.with_suffix(target.suffix + ".partial")
    if temporary.exists():
        raise FileExistsError(f"Partial download exists at {temporary}; inspect it before retrying")
    url = f"https://huggingface.co/{repo}/resolve/{revision}/{filename}"
    try:
        with urllib.request.urlopen(url, timeout=60) as response, temporary.open("xb") as output:
            for block in iter(lambda: response.read(1024 * 1024), b""):
                output.write(block)
        if sha256(temporary) != expected:
            raise ValueError(f"Downloaded {filename} has the wrong SHA-256")
        os.replace(temporary, target)
    except Exception:
        temporary.unlink(missing_ok=True)
        raise
    print(f"Downloaded and verified {target}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Download the approved GGUF weights explicitly")
    parser.add_argument("--chat", choices=("2b", "0.8b"), default="2b")
    parser.add_argument("--directory", type=Path, default=Path("models"))
    args = parser.parse_args()
    download("embedding", args.directory)
    download(f"chat-{args.chat}", args.directory)


if __name__ == "__main__":
    main()
