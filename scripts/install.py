#!/usr/bin/env python3

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Install or uninstall the OpenClaw Custom Provider Cache plugin."
    )
    parser.add_argument(
        "--openclaw-bin",
        default=os.environ.get("OPENCLAW_BIN", "openclaw"),
        help="Path to the openclaw executable to use.",
    )
    parser.add_argument(
        "--uninstall",
        action="store_true",
        help="Uninstall the plugin with the official OpenClaw CLI.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print the OpenClaw commands without executing them.",
    )
    parser.add_argument(
        "--copy",
        action="store_true",
        help="Use a copied install instead of --link.",
    )
    return parser.parse_args()


def project_root() -> Path:
    return Path(__file__).resolve().parents[1]


def read_plugin_id(root: Path) -> str:
    manifest = json.loads((root / "openclaw.plugin.json").read_text("utf-8"))
    plugin_id = str(manifest.get("id", "")).strip()
    if not plugin_id:
        raise SystemExit("Plugin manifest is missing a non-empty id")
    return plugin_id


def run_command(command: list[str]) -> None:
    result = subprocess.run(command, check=False, capture_output=True, text=True)
    if result.returncode == 0:
        if result.stdout.strip():
            print(result.stdout.rstrip())
        if result.stderr.strip():
            print(result.stderr.rstrip(), file=sys.stderr)
        return
    output = "\n".join(part.strip() for part in (result.stdout, result.stderr) if part.strip())
    raise SystemExit(f"Command failed ({result.returncode}): {' '.join(command)}\n{output}")


def main() -> int:
    args = parse_args()
    root = project_root()
    plugin_id = read_plugin_id(root)
    if args.uninstall:
        commands = [[args.openclaw_bin, "plugins", "uninstall", plugin_id, "--force"]]
    else:
        install = [args.openclaw_bin, "plugins", "install"]
        if not args.copy:
            install.append("--link")
        install.append(str(root))
        commands = [
            install,
            [args.openclaw_bin, "config", "set", f"plugins.entries.{plugin_id}.enabled", "true"],
        ]

    for command in commands:
        print("$ " + " ".join(command))

    if args.dry_run:
        return 0

    for command in commands:
        run_command(command)
    return 0


if __name__ == "__main__":
    sys.exit(main())
