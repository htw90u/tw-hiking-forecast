"""Ensure third-party requirements are importable.

Packages are only ever installed into a virtual environment (never into the
system interpreter). If the current interpreter is not a venv, a project-local
``.venv`` is created and the current command is re-executed inside it.
"""
import importlib.util
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
REQUIREMENTS = ROOT / "requirements.txt"
# import name -> pip requirement name
MODULES = {"numpy": "numpy", "PIL": "Pillow", "scipy": "scipy"}


def _in_venv() -> bool:
    return sys.prefix != getattr(sys, "base_prefix", sys.prefix)


def _missing() -> list:
    return [m for m in MODULES if importlib.util.find_spec(m) is None]


def ensure_requirements() -> None:
    if not _missing():
        return
    if not _in_venv():
        venv = ROOT / ".venv"
        py = venv / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
        if not py.exists():
            print(f"[bootstrap] creating virtualenv at {venv}", flush=True)
            subprocess.check_call([sys.executable, "-m", "venv", str(venv)])
        print(f"[bootstrap] re-running inside {venv}", flush=True)
        # orig_argv keeps "-m pipeline.build" (argv[0] would be the file path).
        args = getattr(sys, "orig_argv", [sys.executable] + sys.argv)[1:]
        os.execv(str(py), [str(py)] + args)
    print(f"[bootstrap] installing {', '.join(_missing())} from requirements.txt", flush=True)
    subprocess.check_call([sys.executable, "-m", "pip", "install", "-q", "-r", str(REQUIREMENTS)])
    importlib.invalidate_caches()
    still = _missing()
    if still:
        raise SystemExit(f"[bootstrap] FAIL: still missing {still}")
