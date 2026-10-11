"""Editable prompt files are loaded together at the outer boundary."""

from pathlib import Path

import pytest

from small_rag.adapters.prompt_files import load_system_prompt


def test_custom_prompt_files_replace_default_instructions(tmp_path: Path) -> None:
    system = tmp_path / "system.md"
    soul = tmp_path / "SOUL.md"
    system.write_text("Only answer from evidence.", encoding="utf-8")
    soul.write_text("Be concise and polite.", encoding="utf-8")

    assert load_system_prompt(system, soul) == "Only answer from evidence.\n\nBe concise and polite."


def test_empty_prompt_file_fails_at_startup(tmp_path: Path) -> None:
    system = tmp_path / "system.md"
    soul = tmp_path / "SOUL.md"
    system.write_text("Mission", encoding="utf-8")
    soul.write_text("  \n", encoding="utf-8")

    with pytest.raises(ValueError, match="Prompt file is empty"):
        load_system_prompt(system, soul)
