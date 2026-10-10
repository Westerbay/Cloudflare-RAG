"""Run the internal benchmark and report each container's main-process RSS on Linux."""

import argparse
import json
import platform
import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
COMPOSE = ROOT / "infra" / "compose.yml"


def run(*args: str) -> str:
    return subprocess.check_output(args, cwd=ROOT, text=True).strip()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--question", required=True)
    parser.add_argument("--profile", choices=("local", "domain"), default="local")
    args = parser.parse_args()
    override = ROOT / "infra" / f"compose.{args.profile}.yml"
    base = ("docker", "compose", "-f", str(COMPOSE), "-f", str(override))
    output = run(*base, "exec", "-T", "api", "python", "scripts/benchmark_core.py", "--question", args.question)
    result = json.loads(output)
    rss: dict[str, int | None] = {}
    for service in ("db", "embeddings", "chat", "api", "caddy"):
        if service == "caddy" and args.profile != "domain":
            continue
        container = run(*base, "ps", "-q", service)
        if not container:
            rss[service] = None
            continue
        pid = int(run("docker", "inspect", "--format", "{{.State.Pid}}", container))
        try:
            status = Path(f"/proc/{pid}/status").read_text()
            rss[service] = int(next(line.split()[1] for line in status.splitlines() if line.startswith("VmRSS:")))
        except (OSError, StopIteration):
            rss[service] = None
    result["main_process_rss_kib"] = rss
    result["rss_note"] = "Linux host /proc VmRSS for each container PID 1; PostgreSQL workers and page cache are not included"
    result["host_machine"] = platform.platform()
    print(json.dumps(result, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
