#!/usr/bin/env python3
"""Opt-in real Pi menus + installed daemon + already-downloaded local models (POSIX)."""
import fcntl
import json
import os
import pathlib
import pty
import re
import select
import shutil
import signal
import socket
import struct
import subprocess
import tempfile
import termios
import time

ROOT = pathlib.Path(__file__).resolve().parents[2]
if "ZG_ACCEPTANCE_MODEL_CACHE" not in os.environ:
    raise SystemExit("Set ZG_ACCEPTANCE_MODEL_CACHE to a cache containing downloaded potion-code-16m-v2 and potion-retrieval-32m models; this test never approves downloads.")
CACHE = pathlib.Path(os.environ["ZG_ACCEPTANCE_MODEL_CACHE"]).resolve()
EVIDENCE = pathlib.Path(os.environ.get("PI_TEST_EVIDENCE", "/tmp/pi-zvec-real-menu-evidence")).resolve()
EVIDENCE.mkdir(parents=True, exist_ok=True)
ANSI = re.compile(r"\x1b\][^\x07]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]")
CREATE_MODEL = "local/potion-code-16m-v2"
SWITCH_MODEL = "local/potion-retrieval-32m"


class Pi:
    def __init__(self, label, work, env):
        self.label = label
        self.raw = bytearray()
        self.master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 44, 120, 0, 0))
        self.proc = subprocess.Popen([
            shutil.which("pi"), "--offline", "--no-extensions", "-e", str(ROOT / "index.ts"),
            "--no-mcp", "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-session",
            "--provider", "fixture", "--model", "fixture", "--tui-mode", "regular",
        ], cwd=work, env={**env, "ZVEC_GREP_SERVER_URL": env["PROXY_URL"] + "/" + label},
            stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
        os.close(slave)

    def drain(self, timeout=0.05):
        if select.select([self.master], [], [], max(0, timeout))[0]:
            try:
                data = os.read(self.master, 65536)
            except OSError:
                return
            self.raw.extend(data)
            if b"\x1b[6n" in data:
                os.write(self.master, b"\x1b[1;1R")
            if b"\x1b[c" in data:
                os.write(self.master, b"\x1b[?1;2c")

    def settle(self, seconds=0.3):
        until = time.monotonic() + seconds
        while time.monotonic() < until:
            self.drain(min(0.05, until - time.monotonic()))

    def text(self, since=0):
        return ANSI.sub("", self.raw[since:].decode("utf8", "replace"))

    def wait(self, text, since=0, timeout=45):
        until = time.monotonic() + timeout
        while time.monotonic() < until:
            self.drain()
            if text in self.text(since):
                return
            if self.proc.poll() is not None:
                break
        raise AssertionError(f"{self.label} did not display {text!r}; tail={self.text()[-3500:]!r}")

    def send(self, text):
        at = len(self.raw)
        if text.startswith("/"):
            for char in text:
                if char == "\r":
                    self.settle(0.2)
                os.write(self.master, char.encode())
                self.drain(0.015)
        else:
            os.write(self.master, text.encode())
        return at

    def choose(self, index):
        for _ in range(index):
            self.send("\x1b[B")
            self.settle(0.12)
        self.settle(0.2)
        return self.send("\r")

    def menu(self, expected):
        at = self.send("/zvec\r")
        self.wait("Index Manager", at)
        self.wait(expected, at)
        self.settle()
        return at

    def close_menu(self):
        self.send("\x1b")
        self.settle(0.4)

    def close(self):
        if self.proc.poll() is None:
            self.send("\x1b")
            self.settle(0.2)
            self.send("/quit\r")
            until = time.monotonic() + 10
            while self.proc.poll() is None and time.monotonic() < until:
                self.drain()
            if self.proc.poll() is None:
                self.proc.terminate()
                try:
                    self.proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    self.proc.kill()
                    self.proc.wait()
        (EVIDENCE / f"pi-{self.label}-{self.proc.pid}.log").write_bytes(self.raw)
        os.close(self.master)


def json_line(proc, timeout=30):
    until = time.monotonic() + timeout
    while time.monotonic() < until:
        if select.select([proc.stdout], [], [], 0.1)[0]:
            line = proc.stdout.readline()
            if not line:
                raise AssertionError("observer exited")
            try:
                return json.loads(line)
            except ValueError:
                pass
    raise AssertionError("observer timed out")


def run():
    results = {"passed": False, "models": [CREATE_MODEL, SWITCH_MODEL], "operations": [], "propagation": {}, "concurrency": {}}
    with tempfile.TemporaryDirectory(prefix="pi-zvec-real-menus-") as temporary:
        base = pathlib.Path(temporary).resolve()
        work, agent = base / "workspace", base / "agent"
        work.mkdir()
        agent.mkdir()
        (work / "value.ts").write_text("export const value = 1;\n")
        (work / ".gitignore").write_text(".zvec-grep/\n")
        subprocess.run(["git", "init", "-q", "--initial-branch=main", str(work)], check=True,
                       env={key: value for key, value in os.environ.items() if key not in ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE"]})
        (agent / "models.json").write_text(json.dumps({"providers": {"fixture": {
            "baseUrl": "http://127.0.0.1:9/v1", "api": "openai-completions", "apiKey": "fixture",
            "models": [{"id": "fixture"}],
        }}}))
        (agent / "settings.json").write_text(json.dumps({"quietStartup": True, "theme": "dark"}))
        env = dict(os.environ, HOME=str(base), USERPROFILE=str(base), PI_CODING_AGENT_DIR=str(agent),
                   ZVEC_GREP_HOME=str(base / "zvec-home"), ZVEC_GREP_MODEL_CACHE=str(CACHE),
                   PI_OFFLINE="1", TERM="xterm-256color")
        for key in ["ZVEC_GREP_SERVER_URL", "ZVEC_GREP_SERVER_TOKEN", "ZVEC_GREP_SERVER_TOKEN_FILE", "ZVEC_GREP_EMBEDDING",
                    "GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE"]:
            env.pop(key, None)
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
        upstream = f"http://127.0.0.1:{port}/mcp"
        daemon = None
        daemon_log = open(EVIDENCE / "daemon-console.log", "w")
        observer_log = open(EVIDENCE / "observer-errors.log", "w")
        observer = None
        clients = []
        records_path = EVIDENCE / "mcp.ndjson"
        records_path.write_text("")

        def start_daemon():
            nonlocal daemon
            daemon = subprocess.Popen([shutil.which("zg"), "server", "run", "--listen", f"127.0.0.1:{port}", "--mcp-toolset", "full"],
                                      env=env, stdout=daemon_log, stderr=daemon_log, start_new_session=True)
            until = time.monotonic() + 30
            while time.monotonic() < until:
                assert daemon.poll() is None, "daemon failed; inspect daemon-console.log"
                try:
                    with socket.create_connection(("127.0.0.1", port), timeout=0.2):
                        return
                except OSError:
                    time.sleep(0.1)
            raise AssertionError("daemon did not listen")

        def stop_daemon():
            if daemon and daemon.poll() is None:
                daemon.terminate()
                try:
                    daemon.wait(timeout=20)
                except subprocess.TimeoutExpired:
                    daemon.kill()
                    daemon.wait()

        def status():
            observer.stdin.write(json.dumps({"action": "status", "id": time.monotonic(), "root": str(work)}) + "\n")
            observer.stdin.flush()
            response = json_line(observer)
            assert "error" not in response, response
            return response["status"]

        def records():
            return [json.loads(line) for line in records_path.read_text().splitlines() if line]

        def writes():
            return [record for record in records() if record["source"] in ["a", "b"] and record["tool"] == "zvec_grep_index"]

        def wait_writes(count, timeout=30):
            until = time.monotonic() + timeout
            while time.monotonic() < until:
                if len(writes()) >= count:
                    return
                for client in clients:
                    client.drain(0.02)
            raise AssertionError(f"expected {count} menu index requests, got {writes()}")

        def ready(model, count, timeout=120):
            until = time.monotonic() + timeout
            while time.monotonic() < until:
                current = status()
                persistent, runtime = current.get("persistent", {}), current.get("runtime", {})
                files = persistent.get("files", {})
                embedding = persistent.get("workspace_index", {}).get("embedding", {})
                if (current.get("indexed") and embedding.get("model") == model.removeprefix("local/")
                    and runtime.get("job_state") == "succeeded"
                    and all(files.get(key) == count for key in ["stored", "scanned", "indexed"])
                    and all(files.get(key, 0) == 0 for key in ["pending", "failed", "added", "modified", "deleted"])):
                    return current
                for client in clients:
                    client.drain(0.01)
                time.sleep(0.4)
            raise AssertionError(f"index did not become ready: {current}")

        def refresh_until(client, expected, timeout=30):
            until = time.monotonic() + timeout
            while time.monotonic() < until:
                at = client.send("\x1b[I")
                client.settle(0.8)
                if expected in client.text(at):
                    return
            raise AssertionError(f"{client.label} did not recover to {expected}")

        def snapshot(name, current):
            for client in clients:
                refresh_until(client, "ready (last check)")
            (EVIDENCE / f"status-{name}.json").write_text(json.dumps(current, indent=2))
            result = {"name": name, "stored": current["persistent"]["files"]["stored"],
                      "embedding": current["persistent"]["workspace_index"]["embedding"],
                      "job_state": current.get("runtime", {}).get("job_state"), "requests_so_far": len(writes())}
            results["operations"].append(result)
            print(json.dumps(result), flush=True)

        try:
            start_daemon()
            observer = subprocess.Popen(["node", "--experimental-strip-types", str(ROOT / "test/environments/acceptance-proxy.mjs"), upstream, str(records_path)],
                                        env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=observer_log, text=True)
            endpoint = json_line(observer)
            assert endpoint.get("ready"), endpoint
            labels = [choice["model"] for choice in endpoint["choices"]]
            for model in [CREATE_MODEL, SWITCH_MODEL]:
                assert any(choice["model"] == model and choice["status"] == "Downloaded" for choice in endpoint["choices"]), f"pre-download {model} before this opt-in test"
            env["PROXY_URL"] = endpoint["url"]
            a = Pi("a", work, env)
            clients.append(a)
            a.wait("no index")
            a.menu("Create index")
            at = a.choose(2)
            a.wait("Local embedding models", at)
            at = a.choose(labels.index(CREATE_MODEL))
            a.wait("Project:", at)
            a.wait("Yes", at)
            at = a.choose(0)
            wait_writes(1)
            snapshot("create", ready(CREATE_MODEL, 1))

            # Change files while the real daemon is stopped: no native watcher can pre-empt the menu operation.
            stop_daemon()
            (work / "value.ts").write_text("export const value = 2;\n")
            (work / "extra.ts").write_text("export const extra = 'incremental';\n")
            start_daemon()
            refresh_until(a, "stale")
            a.menu("Update index (incremental)")
            at = a.choose(2)
            a.wait("Project:", at)
            at = a.choose(0)
            wait_writes(2)
            snapshot("incremental", ready(CREATE_MODEL, 2))
            a.menu("Rebuild index")
            at = a.choose(4)
            a.wait("Project:", at)
            at = a.choose(0)
            wait_writes(3)
            snapshot("rebuild", ready(CREATE_MODEL, 2))
            a.menu("Switch model and rebuild")
            at = a.choose(3)
            a.wait("Local embedding models", at)
            at = a.choose(labels.index(SWITCH_MODEL))
            a.wait("Project:", at)
            at = a.choose(0)
            wait_writes(4)
            snapshot("switch", ready(SWITCH_MODEL, 2))
            manual = writes()
            assert len(manual) == 4, manual
            assert [record["args"] for record in manual] == [
                {"root": str(work), "embedding": CREATE_MODEL, "wait": False},
                {"root": str(work), "wait": False},
                {"root": str(work), "rebuild": True, "wait": False},
                {"root": str(work), "rebuild": True, "embedding": SWITCH_MODEL, "wait": False},
            ]

            a.menu("Auto-update: off")
            at = a.choose(5)
            a.wait("Enable automatic index updates?", at)
            at = a.choose(0)
            a.wait("Auto-update: on", at)
            a.close_menu()
            settings = agent / "zvec-status.json"
            assert json.loads(settings.read_text())["autoUpdate"] is True
            b = Pi("b", work, env)
            clients.append(b)
            b.wait("ready (last check)")
            b.menu("Auto-update: on")
            at = b.choose(5)
            b.wait("Auto-update: off", at)
            b.close_menu()
            assert json.loads(settings.read_text())["autoUpdate"] is False
            a.menu("Auto-update: off")
            a.close_menu()
            results["propagation"] = {"independent_pids": [a.proc.pid, b.proc.pid], "startup_inherits_on": True, "b_disables_a_observes_off": True}
            a.menu("Auto-update: off")
            at = a.choose(5)
            a.wait("Enable automatic index updates?", at)
            at = a.choose(0)
            a.wait("Auto-update: on", at)
            a.close_menu()
            at = b.send("/reload\r")
            b.wait("ready (last check)", at)
            b.menu("Auto-update: on")
            b.close_menu()
            results["propagation"]["reload_preserves_on"] = True
            print(json.dumps({"propagation": results["propagation"]}), flush=True)

            stop_daemon()
            for index in range(80):
                (work / f"batch-{index:03}.ts").write_text(f"export function item{index}(input: number) {{ return input + {index}; }}\n")
            start_daemon()
            before = len(writes())
            started = time.monotonic()
            for client in [a, b]:
                refresh_until(client, "stale")
            until = time.monotonic() + 6
            while time.monotonic() < until:
                a.drain(0.02)
                b.drain(0.02)
            for client in [a, b]:
                client.send("\x1b[I")
            final = ready(SWITCH_MODEL, 82)
            for client in [a, b]:
                at = client.send("\x1b[I")
                client.wait("ready (last check)", at)
            a.settle(0.8)
            b.settle(0.8)
            automatic = writes()[before:]
            assert automatic, "no plugin auto-update request observed"
            assert all(record["args"] == {"root": str(work), "wait": False} for record in automatic), automatic
            assert json.loads(settings.read_text())["autoUpdate"] is True, "concurrent updates unexpectedly disabled the global setting"
            jobs = [record["response"].get("result", {}).get("structuredContent", {}) for record in automatic]
            assert len({job.get("job_id") for job in jobs}) == 1, "one edit batch unexpectedly created distinct automatic jobs"
            results["concurrency"] = {"both_footers_ready": True, "elapsed_seconds": round(time.monotonic() - started, 2), "automatic_requests": len(automatic),
                                      "sources": [record["source"] for record in automatic], "job_results": jobs,
                                      "unique_job_ids": sorted({job.get("job_id") for job in jobs if job.get("job_id")}),
                                      "global_setting_still_on": True, "final_stored": final["persistent"]["files"]["stored"]}
            snapshot("concurrent-auto", final)
            print(json.dumps({"concurrency": results["concurrency"]}), flush=True)
            a.menu("Auto-update: on")
            at = a.choose(5)
            a.wait("Auto-update: off", at)
            a.close_menu()
            b.menu("Auto-update: off")
            b.close_menu()
            observer.stdin.write(json.dumps({"action": "artifacts", "id": "after"}) + "\n")
            observer.stdin.flush()
            assert json_line(observer)["artifacts"] == endpoint["artifacts"], "model artifacts changed during acceptance"
            results["model_artifacts_unchanged"] = True
        finally:
            for client in reversed(clients):
                client.close()
            if observer and observer.poll() is None:
                observer.stdin.write('{"action":"exit"}\n')
                observer.stdin.flush()
                try:
                    observer.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    observer.kill()
                    observer.wait()
            stop_daemon()
            log = base / "zvec-home" / "daemon" / "logs" / "server.log"
            if log.exists():
                shutil.copyfile(log, EVIDENCE / "daemon-events.ndjson")
                events = [json.loads(line) for line in log.read_text().splitlines()]
                results["daemon_retries"] = [event for event in events if event["event"] == "job.retry"]
                results["daemon_finished_jobs"] = [event for event in events if event["event"] == "job.finished"]
            results["client_exits"] = [client.proc.returncode for client in clients]
            (EVIDENCE / "results.json").write_text(json.dumps(results, indent=2))
            daemon_log.close()
            observer_log.close()
    assert all(code == 0 for code in results["client_exits"]), results
    results["passed"] = True
    (EVIDENCE / "results.json").write_text(json.dumps(results, indent=2))
    print(json.dumps({"evidence": str(EVIDENCE), **results}, indent=2), flush=True)


if __name__ == "__main__":
    run()
