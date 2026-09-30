"""Run unmodified native CLIs in one terminal; transfer only after a saved request."""
import argparse
import errno
import fcntl
import hashlib
import json
import os
import pathlib
import pty
import select
import shutil
import signal
import sys
import termios
import time
import tty
import uuid


def atomic_json(file, value):
    tmp = pathlib.Path(str(file) + ".tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as out:
        json.dump(value, out)
    os.replace(tmp, file)


def validate_request(request, controller):
    if not isinstance(request, dict):
        raise ValueError("Invalid switch request")
    for key in ("version", "token", "cwd"):
        if request.get(key) != controller.get(key):
            raise ValueError("Switch request does not match the terminal controller")
    if request.get("source") != controller["provider"]:
        raise ValueError("Switch request belongs to a previous CLI")
    if request.get("target") not in ("codex", "claude") or request["target"] == request["source"]:
        raise ValueError("Invalid switch target")
    try:
        uuid.UUID(request["handoff"])
    except (ValueError, KeyError, TypeError):
        raise ValueError("Invalid saved handoff ID")
    return request


def validate_archive(request, data):
    workspace = hashlib.sha256(os.path.realpath(request["cwd"]).encode()).hexdigest()[:24]
    root = pathlib.Path(data) / "workspaces" / workspace
    index = json.loads((root / "index.json").read_text())
    rows = [r for r in index["revisions"] if r["id"] == request["handoff"]]
    if len(rows) != 1 or rows[0]["source"]["provider"] != request["source"]:
        raise ValueError("No matching saved source handoff")
    uuid.UUID(rows[0]["taskId"])
    directory = root / "tasks" / rows[0]["taskId"] / "revisions" / request["handoff"]
    manifest = json.loads((directory / "manifest.json").read_text())
    if manifest.get("id") != request["handoff"] or manifest.get("cwd") != os.path.realpath(request["cwd"]):
        raise ValueError("Saved handoff does not match the current workspace")
    for name, checksum in manifest["files"].items():
        if pathlib.Path(name).is_absolute() or ".." in pathlib.Path(name).parts:
            raise ValueError("Unsafe archive path")
        if hashlib.sha256((directory / name).read_bytes()).hexdigest() != checksum:
            raise ValueError("Saved archive failed its integrity check")


def launch_args(provider, native_args, control, data, token, handoff=None):
    executable = shutil.which(provider)
    if not executable:
        raise ValueError("{} is not installed or not on PATH".format(provider))
    args = [executable]
    if provider == "codex":
        # A separate local runtime carries this terminal's control channel into its MCP server.
        args += ["--no-daemon"]
        for name, value in (("HANDOFF_CONTROL_FILE", str(control)), ("HANDOFF_CONTROL_TOKEN", token)):
            args += ["-c", "mcp_servers.cli-handoff.env.{}={}".format(name, json.dumps(value))]
    args += native_args
    if handoff:
        args.append("Use the import-sync skill to continue handoff {} in this directory. Read its checkpoint, check live files, acknowledge it with your exact native session ID, and continue its next action. Do not switch again unless the user asks.".format(handoff))
    return args


def reap(pid):
    try:
        got, status = os.waitpid(pid, os.WNOHANG)
        return status if got else None
    except ChildProcessError:
        return 0


def drain(fd, delay):
    deadline = time.monotonic() + delay
    while time.monotonic() < deadline:
        ready, _, _ = select.select([fd], [], [], min(0.1, max(0, deadline - time.monotonic())))
        if ready:
            try:
                data = os.read(fd, 65536)
                if not data:
                    return
                os.write(sys.stdout.fileno(), data)
            except OSError as error:
                if error.errno == errno.EIO:
                    return
                raise


def stop_owned_cli(pid, fd):
    # Try native cancellation and /exit first. Signals apply only to the PTY child's group.
    for text, delay in ((b"\x03", 0.5), (b"/exit\r", 1.5)):
        if reap(pid) is not None:
            return
        try:
            os.write(fd, text)
        except OSError:
            break
        drain(fd, delay)
    deadline = time.monotonic() + 1
    while time.monotonic() < deadline:
        if reap(pid) is not None:
            return
        time.sleep(0.02)
    for sig in (signal.SIGTERM, signal.SIGKILL):
        try:
            os.killpg(pid, sig)
        except ProcessLookupError:
            return
        except PermissionError:
            # Some managed terminal environments disallow group signals.
            try:
                os.kill(pid, sig)
            except ProcessLookupError:
                return
        drain(fd, 0.5)
        if reap(pid) is not None:
            return
    try:
        os.waitpid(pid, 0)
    except ChildProcessError:
        pass


def run(opts):
    if not os.isatty(0) or not os.isatty(1):
        raise ValueError("handoff start requires an interactive terminal")
    cwd = os.path.realpath(opts.cwd)
    control = pathlib.Path(opts.control)
    request_file = pathlib.Path(str(control) + ".request")
    original = termios.tcgetattr(0)
    pid = fd = None
    provider = opts.provider
    handoff = None
    native_args = opts.native_args[1:] if opts.native_args[:1] == ["--"] else opts.native_args

    def interrupt(signum, _frame):
        raise KeyboardInterrupt

    signal.signal(signal.SIGTERM, interrupt)
    signal.signal(signal.SIGINT, interrupt)

    def resize(*_args):
        if fd is not None:
            try:
                size = fcntl.ioctl(0, termios.TIOCGWINSZ, bytes(8))
                fcntl.ioctl(fd, termios.TIOCSWINSZ, size)
            except OSError:
                pass
    signal.signal(signal.SIGWINCH, resize)

    try:
        tty.setraw(0)
        while True:
            token = uuid.uuid4().hex
            controller = {"version": 1, "pid": os.getpid(), "cwd": cwd, "provider": provider, "token": token, "state": "active"}
            atomic_json(control, controller)
            args = launch_args(provider, native_args, control, opts.data, token, handoff)
            pid, fd = pty.fork()
            if pid == 0:
                os.chdir(cwd)
                env = dict(os.environ)
                for key in ("CODEX_THREAD_ID", "CLAUDE_SESSION_ID", "CLAUDECODE"):
                    env.pop(key, None)
                env["HANDOFF_CONTROL_FILE"] = str(control)
                env["HANDOFF_CONTROL_TOKEN"] = token
                os.execvpe(args[0], args, env)
            resize()
            requested = None
            ended = False
            while not ended:
                if request_file.exists():
                    try:
                        value = validate_request(json.loads(request_file.read_text()), controller)
                        validate_archive(value, opts.data)
                        if not shutil.which(value["target"]):
                            raise ValueError("Target CLI is not available on PATH")
                        requested = value
                        break
                    except (ValueError, OSError, KeyError, TypeError) as error:
                        os.write(1, ("\r\nhandoff: switch refused: {}. Source CLI remains open.\r\n".format(error)).encode())
                        request_file.unlink(missing_ok=True)
                ready, _, _ = select.select([0, fd], [], [], 0.1)
                if fd in ready:
                    try:
                        output = os.read(fd, 65536)
                        if output:
                            os.write(1, output)
                        else:
                            ended = True
                    except OSError as error:
                        if error.errno == errno.EIO:
                            ended = True
                        else:
                            raise
                if 0 in ready:
                    incoming = os.read(0, 65536)
                    if not incoming:
                        ended = True
                    else:
                        try:
                            os.write(fd, incoming)
                        except OSError as error:
                            if error.errno == errno.EIO:
                                ended = True
                            else:
                                raise
                if reap(pid) is not None:
                    ended = True
            if not requested:
                drain(fd, 0.05)
                break
            controller["state"] = "switching"
            atomic_json(control, controller)
            # Let the success response reach the source before closing its native runtime.
            drain(fd, 0.4)
            stop_owned_cli(pid, fd)
            os.close(fd)
            pid = fd = None
            request_file.unlink(missing_ok=True)
            os.write(1, ("\x1b[?1049l\x1b[?25h\x1b[0m\r\nhandoff: Saved {}. Switching to {} in this terminal…\r\n".format(requested["handoff"], requested["target"])).encode())
            provider, handoff = requested["target"], requested["handoff"]
            native_args = []  # Provider-specific launch flags never cross to the other CLI.
        return 0
    finally:
        if pid is not None and fd is not None:
            stop_owned_cli(pid, fd)
            os.close(fd)
        termios.tcsetattr(0, termios.TCSADRAIN, original)
        os.write(1, b"\x1b[?1049l\x1b[?25h\x1b[0m")
        control.unlink(missing_ok=True)
        request_file.unlink(missing_ok=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--provider", choices=["codex", "claude"], required=True)
    parser.add_argument("--cwd", required=True)
    parser.add_argument("--control", required=True)
    parser.add_argument("--data", required=True)
    parser.add_argument("native_args", nargs=argparse.REMAINDER)
    try:
        sys.exit(run(parser.parse_args()))
    except KeyboardInterrupt:
        sys.exit(130)
    except Exception as error:
        print("handoff: {}".format(error), file=sys.stderr)
        sys.exit(1)
