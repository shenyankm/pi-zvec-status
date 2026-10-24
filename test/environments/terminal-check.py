#!/usr/bin/env python3
"""Real Pi + PTY + isolated real zvec daemon; no external model requests."""
import fcntl
import json
import os
import pathlib
import pty
import re
import select
import shutil
import signal
import struct
import subprocess
import tempfile
import termios
import time

ROOT = pathlib.Path(__file__).resolve().parents[2]
EVIDENCE = pathlib.Path(os.environ.get("PI_TEST_EVIDENCE", "/tmp/pi-zvec-gap-evidence"))
EVIDENCE.mkdir(parents=True, exist_ok=True)
ANSI = re.compile(r"\x1b\][^\x07]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]")


def run(mode, theme, suspend):
    with tempfile.TemporaryDirectory(prefix="pi-zvec-pty-") as directory:
        base = pathlib.Path(directory)
        work = base / "workspace"
        work.mkdir()
        agent = base / "agent"
        agent.mkdir()
        (work / "value.ts").write_text("export const value = 0;\n")
        (work / ".gitignore").write_text(".zvec-grep/\n")
        subprocess.run(["git", "init", "-q", "--initial-branch=main", str(work)], check=True)
        subprocess.run(["git", "-C", str(work), "add", "."], check=True)
        subprocess.run(["git", "-C", str(work), "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=" + str(base / "no-hooks"), "commit", "-qm", "fixture"], check=True)
        (agent / "models.json").write_text(json.dumps({"providers": {"fixture": {
            "baseUrl": "http://127.0.0.1:9/v1", "api": "openai-completions", "apiKey": "fixture",
            "models": [{"id": "fixture"}]
        }}}))
        (agent / "settings.json").write_text(json.dumps({"theme": theme, "quietStartup": True}))
        widget = base / "widget.ts"
        widget.write_text('export default pi => pi.on("session_start", (_event, ctx) => { if (ctx.mode === "tui") ctx.ui.setWidget("height-fixture", Array.from({length: 8}, (_, i) => `Host widget ${i}`)); });\n')
        env = dict(os.environ, HOME=str(base), USERPROFILE=str(base), PI_CODING_AGENT_DIR=str(agent),
                   ZVEC_GREP_HOME=str(base / "zvec-home"), TERM="xterm-256color", PI_OFFLINE="1")
        env.pop("ZVEC_GREP_SERVER_TOKEN_FILE", None)
        daemon = subprocess.Popen(["node", str(ROOT / "test/environments/daemon.mjs"), str(work)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env)

        def daemon_message(expected, timeout=30):
            deadline = time.monotonic() + timeout
            while time.monotonic() < deadline:
                ready, _, _ = select.select([daemon.stdout], [], [], 0.2)
                if ready:
                    line = daemon.stdout.readline()
                    if not line:
                        raise AssertionError("daemon exited: " + daemon.stderr.read())
                    try:
                        value = json.loads(line)
                    except ValueError:
                        continue
                    if expected(value):
                        return value
            raise AssertionError("daemon response timed out")

        def daemon_command(action):
            daemon.stdin.write(json.dumps({"action": action}) + "\n")
            daemon.stdin.flush()
            daemon_message(lambda value: value.get("ack") == action)

        proc = None
        master = None
        transcript = bytearray()
        try:
            endpoint = daemon_message(lambda value: value.get("ready"))
            env.update(ZVEC_GREP_SERVER_URL=endpoint["url"], ZVEC_GREP_SERVER_TOKEN=endpoint["token"])
            master, slave = pty.openpty()
            fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 80, 0, 0))
            proc = subprocess.Popen([shutil.which("pi"), "--offline", "--no-extensions", "-e", str(ROOT / "index.ts"), "-e", str(widget),
                                     "--no-mcp", "--no-skills", "--no-prompt-templates", "--no-context-files",
                                     "--no-session", "--provider", "fixture", "--model", "fixture", "--tui-mode", mode],
                                    cwd=work, env=env, stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
            os.close(slave)

            def drain(timeout=0.2):
                ready, _, _ = select.select([master], [], [], timeout)
                if ready:
                    try:
                        data = os.read(master, 65536)
                    except OSError:
                        return
                    transcript.extend(data)
                    if b"\x1b[6n" in data:
                        os.write(master, b"\x1b[1;1R")
                    if b"\x1b[c" in data:
                        os.write(master, b"\x1b[?1;2c")

            def settle(seconds=0.5):
                deadline = time.monotonic() + seconds
                while time.monotonic() < deadline:
                    drain(min(0.05, deadline - time.monotonic()))

            def wait(text, since=0, timeout=20):
                deadline = time.monotonic() + timeout
                while time.monotonic() < deadline:
                    drain()
                    if text in ANSI.sub("", transcript[since:].decode("utf-8", "replace")):
                        return
                    if proc.poll() is not None:
                        break
                raise AssertionError("PTY did not display " + repr(text))

            def send(text):
                at = len(transcript)
                if text.startswith("/"):
                    for character in text:
                        if character == "\r":
                            settle(0.2)
                        os.write(master, character.encode())
                        drain(0.04)
                else:
                    os.write(master, text.encode())
                return at

            wait("ready (last check)")
            at = send("/zvec\r")
            wait("Index Manager", at)
            wait("Update index", at)
            fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 40, 0, 0))
            proc.send_signal(signal.SIGWINCH)
            settle()
            assert proc.poll() is None
            at = send("\x1b[B")
            settle(0.1)
            send("\x1b[B")
            wait("Update index", at)
            at = len(transcript)
            for _ in range(10):
                send("\x1b[C")
                settle(0.06)
            wait("Checked:", at)
            for _ in range(10):
                send("\x1b[D")
                settle(0.06)
            fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 80, 0, 0))
            proc.send_signal(signal.SIGWINCH)
            daemon_command("offline")
            wait("unavailable", send("\x1b[I"))
            daemon_command("online")
            wait("ready", send("\x1b[I"))
            if suspend and not os.environ.get("PI_TEST_SKIP_SUSPEND"):
                proc.send_signal(signal.SIGSTOP)
                daemon_command("offline")
                time.sleep(31)
                at = len(transcript)
                proc.send_signal(signal.SIGCONT)
                wait("unavailable", at)
                daemon_command("online")
                wait("ready", send("\x1b[I"))
            send("\x1b")
            settle()
            wait("read-only", send("/zvec worktrees\r"))
            settle()
            send("\x1b")
            settle()
            send("/quit\r")
            deadline = time.monotonic() + 10
            while proc.poll() is None and time.monotonic() < deadline:
                drain()
            assert proc.poll() == 0, "Pi did not exit cleanly"
            return {"mode": mode, "theme": theme, "bytes": len(transcript), "resize": True,
                    "live_disconnect_recovery": True, "overview": True, "short_terminal": "80x24 / 40x24", "details_scroll": True, "host_widget_rows": 8,
                    "real_suspend_31s": suspend and not bool(os.environ.get("PI_TEST_SKIP_SUSPEND")), "exit": proc.returncode}
        finally:
            (EVIDENCE / ("pty-" + mode + ".log")).write_bytes(transcript)
            if proc and proc.poll() is None:
                proc.send_signal(signal.SIGCONT)
                proc.terminate()
                try:
                    proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.wait()
            if master is not None:
                os.close(master)
            if daemon.poll() is None:
                daemon.stdin.write('{"action":"exit"}\n')
                daemon.stdin.flush()
                try:
                    daemon.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    daemon.kill()
                    daemon.wait()


if __name__ == "__main__":
    results = [run("regular", "dark", True), run("fullscreen", "light", False)]
    (EVIDENCE / "pty-results.json").write_text(json.dumps(results, indent=2))
    print(json.dumps(results, indent=2))
