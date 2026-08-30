"""Task definition and loading (SPEC §4.9).

A task is a repository state, a prompt, and a command that decides whether the
agent solved it. The verification command is the whole point: solve rate must
come from running code, never from a model judging its own work.
"""

from __future__ import annotations

import shutil
import subprocess
import tempfile
from dataclasses import dataclass, field
from pathlib import Path

import yaml


@dataclass(frozen=True)
class Task:
    id: str
    suite: str
    prompt: str
    #: Files written into the scratch repo before the agent runs.
    files: dict[str, str] = field(default_factory=dict)
    #: Shell command run after the agent finishes. Exit 0 means solved.
    verify: str = ""
    #: Per-task wall-clock cap in seconds.
    timeout_s: int = 600

    @staticmethod
    def from_yaml(path: Path) -> "Task":
        data = yaml.safe_load(path.read_text(encoding="utf-8"))
        missing = {"id", "suite", "prompt", "verify"} - data.keys()
        if missing:
            raise ValueError(f"{path}: missing required field(s): {sorted(missing)}")
        return Task(
            id=data["id"],
            suite=data["suite"],
            prompt=data["prompt"],
            files=data.get("files", {}),
            verify=data["verify"],
            timeout_s=int(data.get("timeout_s", 600)),
        )

    def materialize(self) -> Path:
        """Writes the task's starting files into a fresh scratch directory."""
        root = Path(tempfile.mkdtemp(prefix=f"nodrel-{self.id}-"))
        for name, content in self.files.items():
            target = root / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(content, encoding="utf-8")
        return root

    def check(self, cwd: Path) -> tuple[bool, str]:
        """Runs the verification command. Returns (solved, output)."""
        if not self.verify:
            return False, "task has no verify command"
        try:
            done = subprocess.run(
                self.verify,
                cwd=cwd,
                shell=True,
                capture_output=True,
                text=True,
                timeout=120,
            )
        except subprocess.TimeoutExpired:
            return False, "verification timed out"
        return done.returncode == 0, (done.stdout + done.stderr)[-2000:]


def load_tasks(root: Path, suite: str | None = None) -> list[Task]:
    """Loads every task under `root`, optionally filtered to one suite."""
    tasks = [Task.from_yaml(p) for p in sorted(root.rglob("*.yaml"))]
    if suite:
        tasks = [t for t in tasks if t.suite == suite]
    ids = [t.id for t in tasks]
    duplicates = {i for i in ids if ids.count(i) > 1}
    if duplicates:
        raise ValueError(f"duplicate task ids: {sorted(duplicates)}")
    return tasks


def cleanup(path: Path) -> None:
    shutil.rmtree(path, ignore_errors=True)
