#!/usr/bin/env python3

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

DEFAULT_ARTIFACT_DIR = ".artifacts"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Install or uninstall the OpenClaw Custom Provider Cache plugin. "
            "Packaged .tgz installs built with npm pack are the default; "
            "use --link only for mutable development installs."
        )
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
        help="Print the npm/OpenClaw commands without executing them.",
    )
    parser.add_argument(
        "--link",
        action="store_true",
        help="Install directly from the mutable repo source with --link for development.",
    )
    parser.add_argument(
        "--artifact-dir",
        default=DEFAULT_ARTIFACT_DIR,
        help=(
            "Directory for npm pack artifacts. Relative paths resolve from the repo root. "
            f"Default: {DEFAULT_ARTIFACT_DIR}"
        ),
    )
    parser.add_argument("--copy", action="store_true", help=argparse.SUPPRESS)
    return parser.parse_args()


def project_root() -> Path:
    return Path(__file__).resolve().parents[1]


def read_plugin_id(root: Path) -> str:
    manifest = json.loads((root / "openclaw.plugin.json").read_text("utf-8"))
    plugin_id = str(manifest.get("id", "")).strip()
    if not plugin_id:
        raise SystemExit("Plugin manifest is missing a non-empty id")
    return plugin_id


def read_package_archive_name(root: Path) -> str:
    package = json.loads((root / "package.json").read_text("utf-8"))
    name = str(package.get("name", "")).strip()
    version = str(package.get("version", "")).strip()
    if not name or not version:
        raise SystemExit("package.json must include non-empty name and version")
    normalized_name = name.lstrip("@").replace("/", "-")
    return f"{normalized_name}-{version}.tgz"


def resolve_artifact_dir(root: Path, value: str) -> Path:
    path = Path(value)
    if path.is_absolute():
        return path
    return root / path


def run_command(command: list[str], cwd: Path | None = None) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(command, check=False, capture_output=True, text=True, cwd=cwd)
    if result.returncode == 0:
        if result.stdout.strip():
            print(result.stdout.rstrip())
        if result.stderr.strip():
            print(result.stderr.rstrip(), file=sys.stderr)
        return result
    output = "\n".join(part.strip() for part in (result.stdout, result.stderr) if part.strip())
    raise SystemExit(f"Command failed ({result.returncode}): {' '.join(command)}\n{output}")


def build_package_artifact(root: Path, artifact_dir: Path, artifact_name: str) -> Path:
    artifact_dir.mkdir(parents=True, exist_ok=True)
    for existing_artifact in artifact_dir.glob("*.tgz"):
        existing_artifact.unlink()

    pack_command = ["npm", "pack", "--pack-destination", str(artifact_dir)]
    print("$ " + " ".join(pack_command), flush=True)
    run_command(pack_command, cwd=root)

    artifact_path = artifact_dir / artifact_name
    if artifact_path.exists():
        return artifact_path

    generated_artifacts = sorted(artifact_dir.glob("*.tgz"))
    if len(generated_artifacts) == 1:
        return generated_artifacts[0]
    raise SystemExit(f"Expected npm pack artifact at {artifact_path}")


def main() -> int:
    args = parse_args()
    root = project_root()
    plugin_id = read_plugin_id(root)
    if args.uninstall:
        commands = [[args.openclaw_bin, "plugins", "uninstall", plugin_id, "--force"]]
    else:
        if args.link:
            install_target = root
            print(f"Mutable source install target: {install_target}", flush=True)
            install = [args.openclaw_bin, "plugins", "install", "--link", str(install_target)]
        else:
            artifact_dir = resolve_artifact_dir(root, args.artifact_dir)
            artifact_name = read_package_archive_name(root)
            artifact_path = artifact_dir / artifact_name
            if args.dry_run:
                print(f"Packaged install artifact (expected): {artifact_path}", flush=True)
                print(
                    "$ " + " ".join(["npm", "pack", "--pack-destination", str(artifact_dir)]),
                    flush=True,
                )
            else:
                artifact_path = build_package_artifact(root, artifact_dir, artifact_name)
                print(f"Packaged install artifact: {artifact_path}", flush=True)
            install = [args.openclaw_bin, "plugins", "install", str(artifact_path)]
        commands = [
            install,
            [args.openclaw_bin, "config", "set", f"plugins.entries.{plugin_id}.enabled", "true"],
        ]

    for command in commands:
        print("$ " + " ".join(command), flush=True)

    if args.dry_run:
        return 0

    for command in commands:
        run_command(command)
    return 0


if __name__ == "__main__":
    sys.exit(main())
