#!/usr/bin/env python3
# -*- coding: utf-8 -*-

"""
Minimal Docker runner (mount local dirs + pre-commands + run command)
"""

from __future__ import annotations
import argparse
import os
import shlex
import sys
from dataclasses import dataclass

import docker
from docker.errors import APIError, NotFound, DockerException


@dataclass
class MountSpec:
    host: str
    container: str
    mode: str = "rw"  # or "ro"


def parse_mount(spec: str) -> MountSpec:
    parts = spec.split(":")
    if len(parts) < 2 or len(parts) > 3:
        raise ValueError(f"Invalid --mount '{spec}'. Expect HOST:CONTAINER[:rw|ro].")

    host = os.path.expanduser(parts[0])
    if not os.path.isabs(host):
        host = os.path.abspath(host)
    if not os.path.isdir(host):
        raise ValueError(f"Host path does not exist or is not a directory: {host}")

    container = parts[1]
    if not container.startswith("/"):
        raise ValueError(f"Container path must be absolute: {container}")

    mode = "rw"
    if len(parts) == 3:
        mode = parts[2].lower()
        if mode not in ("rw", "ro"):
            raise ValueError(f"Invalid mount mode '{mode}' in '{spec}'. Use rw|ro.")

    return MountSpec(host=host, container=container, mode=mode)


def build_volumes(mounts: list[MountSpec]) -> dict[str, dict[str, str]]:
    return {m.host: {"bind": m.container, "mode": m.mode} for m in mounts}


def bash_cmd(command: str) -> list[str]:
    return ["bash", "-lc", command]


def exec_and_stream(container, command: str, workdir: str | None) -> int:
    if workdir:
        command = f'cd {shlex.quote(workdir)} && {command}'

    exec_id = container.client.api.exec_create(
        container.id, cmd=bash_cmd(command), stdout=True, stderr=True, tty=False
    )["Id"]

    for chunk in container.client.api.exec_start(exec_id, stream=True, demux=False):
        if isinstance(chunk, (bytes, bytearray)):
            sys.stdout.buffer.write(chunk)
            sys.stdout.buffer.flush()
        elif chunk is not None:
            output_str = str(chunk)
            if output_str:
                sys.stdout.write(output_str)
                sys.stdout.flush()

    inspect = container.client.api.exec_inspect(exec_id)
    return int(inspect.get("ExitCode", 1))


def remove_image_with_mode(client: docker.DockerClient, image_ref: str, mode: str) -> None:
    """
    Remove the image by original ref (tag/digest). Mode:
      - 'if-unused': attempt without force; skip on in-use error
      - 'force': force removal
    """
    try:
        img = client.images.get(image_ref)
        image_id = img.id
    except NotFound:
        print(f"[rm-image] image '{image_ref}' not found, nothing to do.", file=sys.stderr)
        return
    except DockerException as e:
        print(f"[rm-image] failed to resolve image '{image_ref}': {e}", file=sys.stderr)
        return

    force = (mode == "force")
    try:
        # docker-py returns a list of dicts (untagged/deleted entries)
        result = client.images.remove(image=image_id, force=force, noprune=False)
        # Pretty-print a compact summary
        deleted = []
        untagged = []
        if result:  # Check if result is not None
            for entry in result: # type: ignore
                if "Deleted" in entry:
                    deleted.append(entry["Deleted"])
                if "Untagged" in entry:
                    untagged.append(entry["Untagged"])
        if untagged:
            print(f"[rm-image] Untagged: {', '.join(untagged)}")
        if deleted:
            print(f"[rm-image] Deleted layers: {len(deleted)}")
        print(f"🧹 Image removed ({mode}): {image_ref}")
    except APIError as e:
        msg = str(e).lower()
        if (mode == "if-unused") and ("image is being used by running container" in msg or "conflict" in msg):
            print(f"[rm-image] skip: image in use. (use --rm-image force to override)", file=sys.stderr)
            return
        print(f"[rm-image] failed to remove image '{image_ref}': {e}", file=sys.stderr)


def main():
    parser = argparse.ArgumentParser(description="Run a container with mounts + pre-commands + main command")
    parser.add_argument("--image", required=True, help="Base image to run, e.g. python:3.11-slim")
    parser.add_argument("--name", default=None, help="Optional container name")
    parser.add_argument("--mount", action="append", default=[], help="HOST:CONTAINER[:rw|ro] (repeatable)")
    parser.add_argument("--workdir", default=None, help="Working directory inside container")
    parser.add_argument("--pre-cmd", dest="pre_cmds", action="append", default=[], help="Pre commands (repeatable)")
    parser.add_argument("--cmd", required=True, help="Main command to run inside container")
    parser.add_argument("--env", action="append", default=[], help="Env KEY=VAL (repeatable)")
    parser.add_argument("--network", default=None, help="Attach to a Docker network after start (optional)")
    parser.add_argument("--user", default=None, help="Run as user, e.g. '1000:1000' (optional)")
    parser.add_argument("--no-auto-remove", action="store_true", help="Disable auto-remove on exit")
    parser.add_argument("--detach", action="store_true", help="Run main command and leave container running")
    parser.add_argument("--pull", action="store_true", help="Pull image before run")
    # NEW: image cleanup policy
    parser.add_argument(
        "--rm-image",
        choices=["never", "if-unused", "force"],
        default="never",
        help="Remove the base image after the run (default: never)."
    )
    args = parser.parse_args()

    # Guard: detach + rm-image is dangerous
    if args.detach and args.rm_image != "never":
        print("[arg error] --rm-image cannot be used with --detach (container keeps running).", file=sys.stderr)
        sys.exit(2)

    # Prepare mounts
    try:
        mounts = [parse_mount(m) for m in args.mount]
    except ValueError as e:
        print(f"[mount error] {e}", file=sys.stderr)
        sys.exit(2)

    volumes = build_volumes(mounts)
    env_dict: dict[str, str] = {}
    for kv in args.env:
        if "=" not in kv:
            print(f"[env warning] ignore invalid KEY=VAL: {kv}", file=sys.stderr)
            continue
        k, v = kv.split("=", 1)
        env_dict[k] = v

    workdir = args.workdir or (mounts[0].container if mounts else "/")
    auto_remove = not args.no_auto_remove

    # Docker client
    try:
        client = docker.from_env()
    except DockerException as e:
        print(f"[docker error] cannot connect to Docker: {e}", file=sys.stderr)
        sys.exit(2)

    # Pull if requested
    if args.pull:
        try:
            print(f"📥 Pulling image: {args.image}")
            client.images.pull(args.image)
        except DockerException as e:
            print(f"[pull error] {e}", file=sys.stderr)
            sys.exit(2)

    # Create HostConfig explicitly to ensure auto_remove works
    try:
        host_config_kwargs = {
            "auto_remove": auto_remove,
            "binds": {h: {"bind": v["bind"], "mode": v["mode"]} for h, v in volumes.items()} if volumes else None,
        }

        # For host networking, specify it in host config
        if args.network == "host":
            host_config_kwargs["network_mode"] = "host"

        host_config = client.api.create_host_config(**host_config_kwargs)
    except Exception as e:
        print(f"[host_config error] {e}", file=sys.stderr)
        sys.exit(2)

    # Create & start container (low-level), wrap to high-level object
    try:
        print(f"🐳 Creating container from {args.image} ...")
        resp = client.api.create_container(
            image=args.image,
            name=args.name,
            command=["sleep", "infinity"],
            tty=False,
            stdin_open=False,
            working_dir=workdir,
            environment=env_dict or None,
            host_config=host_config,
            user=args.user or None,
        )
        container_id = resp.get("Id")
        client.api.start(container_id)
        container = client.containers.get(container_id)
    except APIError as e:
        print(f"[create/start error] {e}", file=sys.stderr)
        sys.exit(2)

    # Attach to network if requested (skip host networking as it's already configured)
    if args.network and args.network != "host":
        try:
            client.api.connect_container_to_network(container_id, args.network)
        except NotFound:
            print(f"[network] network '{args.network}' not found.", file=sys.stderr)
        except APIError as e:
            print(f"[network] failed to connect to '{args.network}': {e}", file=sys.stderr)

    # Cleanup helper when auto_remove=False
    def safe_cleanup():
        if not auto_remove and 'container' in locals() and container:
            try:
                container.stop(timeout=3)
            except Exception:
                # Container might already be stopped or removed
                pass
            try:
                container.remove(force=True)
            except Exception:
                # Container might already be removed
                pass

    try:
        # Pre-commands
        for i, pc in enumerate(args.pre_cmds, 1):
            print(f"⚙️  Pre-cmd {i}/{len(args.pre_cmds)}: {pc}")
            rc = exec_and_stream(container, pc, workdir=workdir)
            if rc != 0:
                print(f"[pre-cmd failed] exit code {rc}", file=sys.stderr)
                safe_cleanup()
                # Try image removal even if pre-cmd failed? Only if user asked; container is gone.
                if args.rm_image != "never":
                    remove_image_with_mode(client, args.image, args.rm_image)
                sys.exit(rc)

        # Main command
        print(f"🚀 Running: {args.cmd}")
        if args.detach:
            start_cmd = (
                f'nohup {args.cmd} >/proc/1/fd/1 2>/proc/1/fd/2 || '
                f'nohup {args.cmd} >/dev/null 2>&1 &'
            )
            rc = exec_and_stream(container, start_cmd, workdir=workdir)
            if rc != 0:
                print(f"[start detached failed] exit code {rc}", file=sys.stderr)
                safe_cleanup()
                sys.exit(rc)
            container_id = getattr(container, 'id', None)
            container_name = getattr(container, 'name', None) or (container_id[:12] if container_id else 'unknown')
            print(f"✅ Started in background. Container: {container_name}")
            # Do not remove image in detach mode
            sys.exit(0)
        else:
            rc = exec_and_stream(container, args.cmd, workdir=workdir)
            if rc != 0:
                print(f"[cmd failed] exit code {rc}", file=sys.stderr)
            else:
                print("✅ Command finished successfully.")

            # Stop container (may already exit)
            try:
                container.stop(timeout=3)
            except Exception:
                pass

            # Remove container if not auto_remove
            if not auto_remove:
                try:
                    container.remove(force=True)
                except Exception:
                    pass

            # Image cleanup policy
            if args.rm_image != "never":
                remove_image_with_mode(client, args.image, args.rm_image)

            sys.exit(rc)

    except KeyboardInterrupt:
        print("\n[interrupt] stopping container ...", file=sys.stderr)
        safe_cleanup()
        if args.rm_image != "never":
            remove_image_with_mode(client, args.image, args.rm_image)
        sys.exit(130)
    except Exception as e:
        print(f"[unexpected error] {e}", file=sys.stderr)
        safe_cleanup()
        if args.rm_image != "never":
            remove_image_with_mode(client, args.image, args.rm_image)
        sys.exit(1)


if __name__ == "__main__":
    main()
