"""Rezhisser film renderer — cluster driver.

Renders every scene of one film in parallel on a Ray cluster and reports on
stdout with two kinds of marker lines, which the Node orchestrator reads from
the job log:

    FILM_PROGRESS {"done": 12, "total": 30}
    FILM_RESULT   {"shots": [...], "failures": [...]}

The video model itself is not part of this file. Each scene is sent to a render
service that must already run on (or be reachable from) the cluster:

    POST {FILM_RENDER_ENDPOINT}/render
         {prompt, negative_prompt, duration, aspect, resolution, fps}
      -> {"url": "https://..."}

The result must be an https URL: the orchestrator downloads clips from there,
because files on a rented node disappear when the cluster is torn down.

Without FILM_RENDER_ENDPOINT every scene fails with a clear error; nothing is
replaced by a placeholder.

Environment:
    FILM_RENDER_ENDPOINT   base URL of the render service (required)
    FILM_RENDER_TIMEOUT_S  per-scene timeout, default 900
    FILM_GPUS_PER_SCENE    GPUs a scene task reserves in Ray, default 0. Set it
                           to 1 when the render service runs on the same nodes
                           and one scene should occupy one GPU.
"""

from __future__ import annotations

import argparse
import base64
import gzip
import json
import os
import sys
import urllib.request
from typing import Any, Dict, List

MAX_SHOTS = 36


def emit(kind: str, payload: Dict[str, Any]) -> None:
    sys.stdout.write(f"{kind} {json.dumps(payload, ensure_ascii=False)}\n")
    sys.stdout.flush()


def load_payload(raw: str) -> Dict[str, Any]:
    payload = json.loads(raw)
    if not isinstance(payload, dict):
        raise ValueError("payload must be a JSON object")
    shots = payload.get("shots")
    if not isinstance(shots, list) or not shots:
        raise ValueError("payload.shots must be a non-empty list")
    if len(shots) > MAX_SHOTS:
        raise ValueError(f"at most {MAX_SHOTS} shots per film")
    for index, shot in enumerate(shots):
        if not isinstance(shot, dict) or not shot.get("prompt"):
            raise ValueError(f"shot {index} has no prompt")
        duration = float(shot.get("durationSeconds", 0))
        if duration < 2 or duration > 10:
            raise ValueError(f"shot {index} duration must be 2..10 seconds")
    return payload


def render_one(shot: Dict[str, Any], context: Dict[str, Any]) -> Dict[str, Any]:
    """Renders one scene. Never raises: the outcome is always a result row."""
    row = {"shotId": shot.get("shotId"), "scene": shot.get("n")}
    try:
        endpoint = (os.environ.get("FILM_RENDER_ENDPOINT") or "").rstrip("/")
        if not endpoint:
            raise RuntimeError("FILM_RENDER_ENDPOINT is not set on the cluster")
        body = json.dumps(
            {
                "prompt": shot["prompt"],
                "negative_prompt": shot.get("negativePrompt", ""),
                "duration": float(shot["durationSeconds"]),
                "aspect": context["aspect"],
                "resolution": context["resolution"],
                "fps": context["fps"],
            }
        ).encode("utf-8")
        request = urllib.request.Request(
            f"{endpoint}/render",
            data=body,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        timeout = float(os.environ.get("FILM_RENDER_TIMEOUT_S", "900"))
        with urllib.request.urlopen(request, timeout=timeout) as response:
            answer = json.loads(response.read().decode("utf-8"))
        url = answer.get("url") if isinstance(answer, dict) else None
        if not isinstance(url, str) or not url.startswith("https://"):
            raise RuntimeError("render service did not return an https url")
        return {**row, "ok": True, "url": url}
    except Exception as error:  # noqa: BLE001 - reported per scene
        return {**row, "ok": False, "code": "render_failed", "message": str(error)[:200]}


def run(payload: Dict[str, Any]) -> Dict[str, Any]:
    shots: List[Dict[str, Any]] = payload["shots"]
    total = len(shots)
    context = {
        "aspect": payload.get("aspect", "16:9"),
        "resolution": payload.get("resolution", "480p"),
        "fps": payload.get("fps", 24),
    }
    rows: List[Dict[str, Any]] = []

    try:
        import ray
    except ImportError:
        # Same contract without Ray: one scene after another.
        emit("FILM_PROGRESS", {"done": 0, "total": total, "mode": "sequential"})
        for index, shot in enumerate(shots):
            rows.append(render_one(shot, context))
            emit("FILM_PROGRESS", {"done": index + 1, "total": total})
    else:
        # Inside a submitted Ray job the cluster address is already set; on a
        # bare node this starts a local Ray instance.
        ray.init(ignore_reinit_error=True)
        gpus = float(os.environ.get("FILM_GPUS_PER_SCENE", "0"))
        task = ray.remote(num_gpus=gpus)(render_one)
        pending = [task.remote(shot, context) for shot in shots]
        emit("FILM_PROGRESS", {"done": 0, "total": total, "mode": "ray"})
        while pending:
            ready, pending = ray.wait(pending, num_returns=1, timeout=60)
            for item in ready:
                try:
                    rows.append(ray.get(item))
                except Exception as error:  # noqa: BLE001 - a lost worker
                    rows.append({"ok": False, "code": "worker_lost", "message": str(error)[:200]})
            emit("FILM_PROGRESS", {"done": len(rows), "total": total})

    return {
        "shots": [row for row in rows if row.get("ok")],
        "failures": [row for row in rows if not row.get("ok")],
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Render one film on a Ray cluster")
    parser.add_argument("--payload-gz64", default="", help="gzip + base64 JSON payload")
    parser.add_argument("--payload-b64", default="")
    parser.add_argument("--payload-file", default="")
    args = parser.parse_args()

    try:
        if args.payload_gz64:
            raw = gzip.decompress(base64.b64decode(args.payload_gz64)).decode("utf-8")
        elif args.payload_b64:
            raw = base64.b64decode(args.payload_b64).decode("utf-8")
        elif args.payload_file:
            with open(args.payload_file, "r", encoding="utf-8") as handle:
                raw = handle.read()
        else:
            raise ValueError("no payload: pass --payload-gz64, --payload-b64 or --payload-file")
        payload = load_payload(raw)
    except Exception as error:  # noqa: BLE001 - reported to the orchestrator
        emit("FILM_RESULT", {"shots": [], "failures": [{"code": "invalid_payload", "message": str(error)[:200]}]})
        return 2

    result = run(payload)
    emit("FILM_RESULT", result)
    return 0 if not result["failures"] else 1


if __name__ == "__main__":
    sys.exit(main())
