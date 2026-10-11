"""Load operator-editable instructions at service startup."""

from pathlib import Path


def load_system_prompt(system_path: Path, soul_path: Path) -> str:
    parts = []
    for path in (system_path, soul_path):
        content = path.read_text(encoding="utf-8").strip()
        if not content:
            raise ValueError(f"Prompt file is empty: {path}")
        parts.append(content)
    return "\n\n".join(parts)
