"""Console + file logging with timestamps in the host time zone.

Keywords such as PASS / FAIL / SUCCESS / WARN are colorized on the console.
Every log file starts with the command needed to reproduce the run.
"""
import os
import re
import shlex
import sys
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

# Containers usually run in UTC; default to the user's host zone (Taiwan).
TZ = ZoneInfo(os.environ.get("LOG_TZ", "Asia/Taipei"))

_COLORS = {
    "PASS": "\033[32m", "SUCCESS": "\033[32m", "OK": "\033[32m",
    "FAIL": "\033[31m", "FAILED": "\033[31m", "ERROR": "\033[31m",
    "WARN": "\033[33m", "SKIP": "\033[36m",
}
_RESET = "\033[0m"
_KW = re.compile(r"\b(" + "|".join(sorted(_COLORS, key=len, reverse=True)) + r")\b", re.I)


def now() -> datetime:
    return datetime.now(TZ)


def _use_color() -> bool:
    if os.environ.get("NO_COLOR"):
        return False
    return bool(os.environ.get("FORCE_COLOR") or os.environ.get("GITHUB_ACTIONS") or sys.stdout.isatty())


def colorize(text: str) -> str:
    return _KW.sub(lambda m: _COLORS[m.group(1).upper()] + m.group(1) + _RESET, text)


class Log:
    def __init__(self, name: str, log_dir: Path, argv=None):
        log_dir = Path(log_dir)
        log_dir.mkdir(parents=True, exist_ok=True)
        stamp = now().strftime("%Y%m%d-%H%M%S")
        self.path = log_dir / f"{name}-{stamp}.log"
        self._fh = open(self.path, "w", encoding="utf-8")
        self._color = _use_color()
        argv = argv if argv is not None else [Path(sys.executable).name, "-m", "pipeline.build"] + sys.argv[1:]
        self._fh.write(f"# Reproduce: cd {Path.cwd()} && {' '.join(shlex.quote(a) for a in argv)}\n")
        self._fh.write(f"# Started: {now().isoformat()}  (time zone {TZ.key})\n")
        self._fh.flush()
        self.failures = []

    def _emit(self, level: str, msg: str) -> None:
        line = f"[{now().strftime('%H:%M:%S')}] {level:<7} {msg}"
        print(colorize(line) if self._color else line, flush=True)
        self._fh.write(line + "\n")
        self._fh.flush()

    def info(self, msg):
        self._emit("INFO", msg)

    def ok(self, msg):
        self._emit("PASS", msg)

    def warn(self, msg):
        self._emit("WARN", msg)

    def fail(self, msg):
        self.failures.append(msg)
        self._emit("FAIL", msg)

    def close(self):
        self._fh.write(f"# Finished: {now().isoformat()}\n")
        self._fh.close()
