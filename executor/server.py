#!/usr/bin/env python3
"""Runner / local-task executor (ADR-016).

Two endpoints on one isolated service:

* ``POST /run``      — legacy, unchanged: device local tasks
                       (``device_commands.target='local'``).
                       One-line body, one-shot JSON response.
* ``POST /run-task`` — tasks: multiple files, own dependencies in a
                       cached environment, phases, **chunked
                       stream** of output (NDJSON), artifacts from ``$RUN_OUTPUT``.

The harness is generic: it does not know what python or node is. "How to
prepare the environment" and "what to run with" are data from ``recipes.json``
(argv arrays, not shell strings). A new runtime = an entry in the recipes + a
toolchain in the Dockerfile; another runner type (ansible) = a separate image
with its own recipes.json.

Zero Supabase credentials in the image (ADR-016) — so artifacts are NOT uploaded
to Storage from here, but handed to the BFF in the final event; the BFF uploads.

stdlib-only. ponytail: container-level isolation; per-job nsjail — once
hostile input becomes real.
"""
import base64
import errno
import fcntl
import hashlib
import json
import mimetypes
import os
import shutil
import subprocess
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

SECRET = os.environ.get("EXECUTOR_SHARED_SECRET", "")
PORT = int(os.environ.get("EXECUTOR_PORT", "8090"))
CACHE_DIR = os.environ.get("RUNNER_CACHE_DIR", "/cache")
CACHE_MAX_MB = int(os.environ.get("RUNNER_CACHE_MAX_MB", "10240"))
# Ceiling for one artifact: it travels to the BFF over HTTP as base64 (see the
# header — no Storage credentials here, on purpose). A bigger file does not vanish
# silently, it goes to `skipped`.
MAX_ARTIFACT_MB = int(os.environ.get("RUNNER_MAX_ARTIFACT_MB", "25"))
# Ceiling for a task's structured result (`$RUN_DATA_FILE`): it lands in
# `task_run.result.data` (jsonb) and in the sink body, so it is no place for
# megabytes — large data belongs in artifacts.
MAX_DATA_KB = int(os.environ.get("RUNNER_MAX_DATA_KB", "64"))
# Environment preparation has its own ceiling: a task's `timeout_s` covers the
# run phase only, otherwise a first run with pip-install would hit the task timeout.
PREPARE_TIMEOUT_S = int(os.environ.get("RUNNER_PREPARE_TIMEOUT_S", "900"))
MAX_BODY = int(os.environ.get("RUNNER_MAX_BODY_MB", "16")) * (1 << 20)

RECIPES_PATH = os.environ.get("RUNNER_RECIPES", os.path.join(os.path.dirname(__file__), "recipes.json"))

# Legacy interpreter map (/run). Do not touch — device local commands live on it.
LEGACY_RUNNERS = {
    "raw": (["sh"], "task.sh"),
    "bash": (["bash"], "task.sh"),
    "python": (["python3"], "task.py"),
    "node": (["node"], "task.js"),
}

_cache_lock = threading.Lock()


def load_recipes():
    with open(RECIPES_PATH, encoding="utf-8") as f:
        raw = json.load(f)
    return {k: v for k, v in raw.items() if not k.startswith("_")}


RECIPES = load_recipes()


# --- legacy /run ---------------------------------------------------------------

def run_task_legacy(interpreter, body, env_in, timeout_ms):
    prefix, fname = LEGACY_RUNNERS[interpreter]
    timeout_s = max(1, int(timeout_ms) // 1000) if timeout_ms else 45
    with tempfile.TemporaryDirectory(prefix="task-") as workdir:
        path = os.path.join(workdir, fname)
        with open(path, "w", encoding="utf-8") as f:
            f.write(body or "")
        env = base_env(workdir)
        for k, v in (env_in or {}).items():
            env[str(k)] = "" if v is None else str(v)
        try:
            p = subprocess.run(
                [*prefix, path],
                cwd=workdir, env=env, capture_output=True, text=True, timeout=timeout_s,
            )
            return {"stdout": p.stdout, "stderr": p.stderr, "exit": p.returncode, "timedOut": False}
        except subprocess.TimeoutExpired as e:
            out = e.stdout or ""
            err = (e.stderr or "") + f"\n[executor] timed out after {timeout_s}s"
            return {"stdout": out if isinstance(out, str) else out.decode(errors="replace"),
                    "stderr": err if isinstance(err, str) else err.decode(errors="replace"),
                    "exit": None, "timedOut": True}


# --- shared -------------------------------------------------------------------

def base_env(home):
    """Whitelisted env: no leak of the main container's env (ADR-016)."""
    return {
        "PATH": os.environ.get("PATH", "/usr/local/bin:/usr/bin:/bin"),
        "HOME": home,
        "LANG": "C.UTF-8",
    }


def env_key(runtime, deps, deps_lock):
    """Environment key. A change of deps or of the lock = another environment."""
    h = hashlib.sha256()
    h.update(runtime.encode())
    h.update(b"\0")
    h.update((deps or "").encode())
    h.update(b"\0")
    h.update((deps_lock or "").encode())
    return f"{runtime}-{h.hexdigest()[:16]}"


def dir_size(path):
    total = 0
    for root, _dirs, files in os.walk(path):
        for name in files:
            try:
                total += os.lstat(os.path.join(root, name)).st_size
            except OSError:
                pass
    return total


def cache_stats():
    """
    How much space the environments use (the cache eats the disk → shown in the panel).
    One os.walk pass per directory — the default cache limit is 10 GB, called on
    page open. // ponytail: no response cache; once the directory reaches tens
    of GB and the call starts to drag — write the size to `.used` at preparation.
    """
    entries = []
    try:
        names = os.listdir(CACHE_DIR)
    except FileNotFoundError:
        names = []
    for name in sorted(names):
        path = os.path.join(CACHE_DIR, name)
        if not os.path.isdir(path):
            continue
        marker = os.path.join(path, ".used")
        try:
            used_at = os.path.getmtime(marker if os.path.exists(marker) else path)
        except OSError:
            used_at = 0
        entries.append({
            "key": name,
            "bytes": dir_size(path),
            "usedAt": used_at,
            "ready": os.path.exists(os.path.join(path, ".ready")),
        })
    return {
        "bytes": sum(e["bytes"] for e in entries),
        "limitBytes": CACHE_MAX_MB * (1 << 20),
        "envs": entries,
    }


def evict_lru(keep_key):
    """LRU eviction when the volume limit is exceeded (the cache eats the disk)."""
    try:
        entries = []
        for name in os.listdir(CACHE_DIR):
            path = os.path.join(CACHE_DIR, name)
            if not os.path.isdir(path) or name == keep_key:
                continue
            marker = os.path.join(path, ".used")
            used_at = os.path.getmtime(marker) if os.path.exists(marker) else os.path.getmtime(path)
            entries.append((used_at, path))
    except FileNotFoundError:
        return []

    total = dir_size(CACHE_DIR)
    limit = CACHE_MAX_MB * (1 << 20)
    evicted = []
    for _used_at, path in sorted(entries):
        if total <= limit:
            break
        size = dir_size(path)
        shutil.rmtree(path, ignore_errors=True)
        total -= size
        evicted.append(os.path.basename(path))
    return evicted


def prepare_env(runtime, recipe, deps, deps_lock, rebuild, emit):
    """
    Prepares (or reuses) an environment for deps. Returns (env_dir, key, prepared).
    `prepared=False` → the preparation phase did not run (cache hit).
    """
    key = env_key(runtime, deps, deps_lock)
    env_dir = os.path.join(CACHE_DIR, key)
    ready = os.path.join(env_dir, ".ready")

    os.makedirs(CACHE_DIR, exist_ok=True)

    if rebuild and os.path.isdir(env_dir):
        shutil.rmtree(env_dir, ignore_errors=True)

    if not deps.strip():
        # No dependencies — no environment needed at all.
        return None, key, False

    # Lock per key: two concurrent runs of the same task must not install
    # packages into one directory in parallel.
    os.makedirs(CACHE_DIR, exist_ok=True)
    lock_path = os.path.join(CACHE_DIR, f"{key}.lock")
    with open(lock_path, "w") as lock_file:
        fcntl.flock(lock_file, fcntl.LOCK_EX)
        try:
            if os.path.exists(ready):
                touch_used(env_dir)
                return env_dir, key, False  # cache hit: no preparing_env phase

            emit({"type": "phase", "phase": "preparing_env", "envKey": key})
            shutil.rmtree(env_dir, ignore_errors=True)
            os.makedirs(env_dir, exist_ok=True)

            deps_file = os.path.join(env_dir, recipe.get("depsFile", "deps.txt"))
            with open(deps_file, "w", encoding="utf-8") as f:
                f.write(deps)
            if deps_lock.strip() and recipe.get("lockFile"):
                with open(os.path.join(env_dir, recipe["lockFile"]), "w", encoding="utf-8") as f:
                    f.write(deps_lock)

            subs = {"env_dir": env_dir, "deps_file": deps_file, "work_dir": env_dir}
            for cmd in recipe.get("prepare", []):
                argv = [expand(a, subs) for a in cmd]
                p = subprocess.run(
                    argv, cwd=env_dir, env=base_env(env_dir),
                    capture_output=True, text=True, timeout=PREPARE_TIMEOUT_S,
                )
                if p.stdout:
                    emit({"type": "log", "stream": "stdout", "data": p.stdout})
                if p.stderr:
                    emit({"type": "log", "stream": "stderr", "data": p.stderr})
                if p.returncode != 0:
                    shutil.rmtree(env_dir, ignore_errors=True)
                    raise RuntimeError(f"prepare failed ({' '.join(argv[:2])}) exit={p.returncode}")

            with open(ready, "w") as f:
                f.write(str(int(time.time())))
            touch_used(env_dir)
            with _cache_lock:
                evicted = evict_lru(key)
            if evicted:
                emit({"type": "log", "stream": "stderr",
                      "data": f"[runner] cache evicted: {', '.join(evicted)}\n"})
            return env_dir, key, True
        finally:
            fcntl.flock(lock_file, fcntl.LOCK_UN)


def touch_used(env_dir):
    try:
        marker = os.path.join(env_dir, ".used")
        with open(marker, "w") as f:
            f.write(str(int(time.time())))
    except OSError:
        pass


def expand(template, subs):
    out = template
    for k, v in subs.items():
        out = out.replace("{" + k + "}", str(v))
    return out


def collect_artifacts(out_dir):
    """Files from $RUN_OUTPUT → base64 in the response (no Storage credentials here)."""
    artifacts, skipped = [], []
    limit = MAX_ARTIFACT_MB * (1 << 20)
    for root, _dirs, files in os.walk(out_dir):
        for name in sorted(files):
            full = os.path.join(root, name)
            rel = os.path.relpath(full, out_dir)
            try:
                size = os.path.getsize(full)
            except OSError:
                continue
            if size > limit:
                skipped.append({"path": rel, "size": size, "reason": "too-large"})
                continue
            with open(full, "rb") as f:
                artifacts.append({
                    "path": rel,
                    "size": size,
                    "contentType": mimetypes.guess_type(name)[0] or "application/octet-stream",
                    "b64": base64.b64encode(f.read()).decode("ascii"),
                })
    return artifacts, skipped


def read_data_file(path):
    """
    `$RUN_DATA_FILE` → (data, error). No file is normal (None, None).
    Broken JSON or an exceeded size does not fail the run, but does not vanish
    silently either: we return the error text, which the BFF shows in the run log.
    """
    try:
        size = os.path.getsize(path)
    except OSError:
        return None, None
    if size > MAX_DATA_KB * 1024:
        return None, f"data file too large: {size}B > {MAX_DATA_KB}KB"
    try:
        with open(path, encoding="utf-8") as f:
            parsed = json.load(f)
    except (OSError, ValueError) as ex:
        return None, f"data file is not valid JSON: {ex}"
    if not isinstance(parsed, dict):
        return None, "data file must contain a JSON object"
    return parsed, None


def run_job(req, emit):
    """Runs a task, streaming events via `emit`. Returns the final event."""
    runtime = req.get("runtime")
    recipe = RECIPES.get(runtime)
    if not recipe:
        return {"type": "end", "exit": None, "timedOut": False, "envKey": None,
                "error": f"unknown runtime '{runtime}' (available: {', '.join(sorted(RECIPES))})"}

    files = req.get("files") or {}
    entrypoint = req.get("entrypoint") or ""
    if entrypoint not in files:
        return {"type": "end", "exit": None, "timedOut": False, "envKey": None,
                "error": "entrypoint is not among files"}

    deps = req.get("deps") or ""
    deps_lock = req.get("depsLock") or ""
    timeout_s = max(1, int(req.get("timeoutMs") or 600_000) // 1000)

    env_dir, key, prepared = prepare_env(runtime, recipe, deps, deps_lock, bool(req.get("rebuildEnv")), emit)

    with tempfile.TemporaryDirectory(prefix="job-") as work_dir:
        # Task files. Nested paths are allowed, but ONLY inside work_dir.
        for name, content in files.items():
            dest = os.path.realpath(os.path.join(work_dir, name))
            if not dest.startswith(os.path.realpath(work_dir) + os.sep):
                return {"type": "end", "exit": None, "timedOut": False, "envKey": key,
                        "error": f"file path escapes the working directory: {name}"}
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            with open(dest, "w", encoding="utf-8") as f:
                f.write(content if isinstance(content, str) else str(content))

        out_dir = os.path.join(work_dir, "out")
        os.makedirs(out_dir, exist_ok=True)

        env = base_env(work_dir)
        for k, v in (req.get("env") or {}).items():
            env[str(k)] = "" if v is None else str(v)

        # The runner injects the paths (only it knows the per-job dir) — the BFF does not invent them.
        env["RUN_OUTPUT"] = out_dir
        payload = req.get("payload")
        if payload is not None:
            payload_file = os.path.join(work_dir, "payload.json")
            with open(payload_file, "w", encoding="utf-8") as f:
                f.write(payload if isinstance(payload, str) else json.dumps(payload))
            env["RUN_PAYLOAD_FILE"] = payload_file

        # Structured-result channel: the task writes JSON here, and it reaches
        # `task_run.result.data` and the sink body. This is how task A passes its
        # fields to task B without mixing with our summary.
        data_file = os.path.join(work_dir, "data.json")
        env["RUN_DATA_FILE"] = data_file

        subs = {"env_dir": env_dir or "", "work_dir": work_dir, "entrypoint": entrypoint}

        for target, link_name in recipe.get("links", []):
            if not env_dir:
                continue
            src = expand(target, subs)
            dst = os.path.join(work_dir, link_name)
            try:
                if os.path.exists(src):
                    os.symlink(src, dst)
            except OSError as ex:
                if ex.errno != errno.EEXIST:
                    raise

        for k, v in (recipe.get("runEnv") or {}).items():
            if env_dir or "{env_dir}" not in v:
                env[k] = expand(v, subs)

        argv_template = recipe["run"] if env_dir else recipe.get("runNoDeps", recipe["run"])
        argv = [expand(a, subs) for a in argv_template]

        emit({"type": "phase", "phase": "running", "envKey": key, "preparedEnv": prepared})

        stdout_chunks, stderr_chunks = [], []
        timed_out = False
        started = time.time()
        try:
            proc = subprocess.Popen(
                argv, cwd=work_dir, env=env, text=True, bufsize=1,
                stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            )
        except OSError as ex:
            return {"type": "end", "exit": None, "timedOut": False, "envKey": key,
                    "error": f"failed to start {argv[0]}: {ex}"}

        def pump(pipe, stream, sink):
            for line in iter(pipe.readline, ""):
                sink.append(line)
                # Chunk goes straight to the stream → the log grows in the panel during the run.
                emit({"type": "log", "stream": stream, "data": line})
            pipe.close()

        threads = [
            threading.Thread(target=pump, args=(proc.stdout, "stdout", stdout_chunks), daemon=True),
            threading.Thread(target=pump, args=(proc.stderr, "stderr", stderr_chunks), daemon=True),
        ]
        for t in threads:
            t.start()

        try:
            proc.wait(timeout=timeout_s)
        except subprocess.TimeoutExpired:
            timed_out = True
            proc.kill()
            proc.wait()
        for t in threads:
            t.join(timeout=5)

        if timed_out:
            msg = f"\n[runner] timed out after {timeout_s}s\n"
            stderr_chunks.append(msg)
            emit({"type": "log", "stream": "stderr", "data": msg})

        artifacts, skipped = collect_artifacts(out_dir)
        data, data_error = read_data_file(data_file)

        return {
            "type": "end",
            "exit": None if timed_out else proc.returncode,
            "timedOut": timed_out,
            "envKey": key,
            "preparedEnv": prepared,
            "durationMs": int((time.time() - started) * 1000),
            "stdout": "".join(stdout_chunks),
            "stderr": "".join(stderr_chunks),
            "artifacts": artifacts,
            "skippedArtifacts": skipped,
            "data": data,
            "dataError": data_error,
        }


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, obj):
        payload = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def _authorized(self):
        return bool(SECRET) and self.headers.get("x-executor-secret") == SECRET

    def _read_json(self):
        length = int(self.headers.get("content-length") or 0)
        if length <= 0 or length > MAX_BODY:
            return None, "bad length"
        try:
            return json.loads(self.rfile.read(length).decode("utf-8")), None
        except Exception:
            return None, "bad json"

    def do_GET(self):
        # Environment cache state for the panel. Same shared-secret gate: the list
        # of environment keys is the client's deps list, not public information.
        if self.path == "/cache":
            if not self._authorized():
                return self._send(403, {"error": "forbidden"})
            return self._send(200, cache_stats())
        return self._send(404, {"error": "not found"})

    def do_POST(self):
        if self.path == "/run":
            return self._handle_legacy()
        if self.path == "/run-task":
            return self._handle_task()
        return self._send(404, {"error": "not found"})

    def _handle_legacy(self):
        if not self._authorized():
            return self._send(403, {"error": "forbidden"})
        req, err = self._read_json()
        if err:
            return self._send(400, {"error": err})
        interpreter = req.get("interpreter")
        if interpreter not in LEGACY_RUNNERS:
            return self._send(400, {"error": "bad interpreter"})
        try:
            result = run_task_legacy(interpreter, req.get("body", ""), req.get("env", {}), req.get("timeoutMs"))
            return self._send(200, result)
        except Exception as ex:  # noqa: BLE001 — the service does not die on one job
            return self._send(200, {"stdout": "", "stderr": f"[executor] {ex}", "exit": None, "timedOut": False})

    def _handle_task(self):
        if not self._authorized():
            return self._send(403, {"error": "forbidden"})
        req, err = self._read_json()
        if err:
            return self._send(400, {"error": err})

        # NDJSON stream: one event per line, the body ends when the connection closes.
        self.send_response(200)
        self.send_header("content-type", "application/x-ndjson")
        self.send_header("connection", "close")
        self.end_headers()

        lock = threading.Lock()

        def emit(event):
            with lock:
                try:
                    self.wfile.write((json.dumps(event) + "\n").encode("utf-8"))
                    self.wfile.flush()
                except (BrokenPipeError, ConnectionResetError):
                    pass  # BFF dropped off — the job still runs to the end

        try:
            final = run_job(req, emit)
        except Exception as ex:  # noqa: BLE001
            final = {"type": "end", "exit": None, "timedOut": False, "error": f"[runner] {ex}"}
        emit(final)

    def log_message(self, *_):
        pass  # quiet: the output may contain sensitive data


if __name__ == "__main__":
    os.makedirs(CACHE_DIR, exist_ok=True)
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
