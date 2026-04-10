#!/usr/bin/env python3
"""
Fixed runner for the ONNX adapter (`OnnxAdapter` in
`src/services/model.service.ts`).

The earlier implementation embedded the model `filePath` directly into a
`python3 -c '...'` string. Any operator that could write to the model
registry could therefore inject arbitrary Python through `filePath`. This
script eliminates that vector by:

  1. Receiving the model path as a positional argument (argv[1]) — never
     interpolated into source code.
  2. Reading the JSON input payload from STDIN, never from arguments.
  3. Refusing to run if the model path is unreadable or has the wrong
     extension.

The adapter on the Node side has *already* validated the path against
`MODEL_ROOT` (see `validateModelFilePath`), but this script also performs a
last-ditch sanity check so it remains safe to call manually as well.
"""

import json
import os
import sys


def fail(msg: str, code: int = 2) -> None:
    sys.stderr.write(msg + "\n")
    sys.exit(code)


def main() -> None:
    if len(sys.argv) != 2:
        fail("usage: onnx_runner.py <model.onnx>")

    model_path = sys.argv[1]
    if not isinstance(model_path, str) or "\0" in model_path:
        fail("invalid model path")
    if not os.path.isfile(model_path):
        fail("model file not found: %s" % model_path)
    if not model_path.lower().endswith(".onnx"):
        fail("model path must end in .onnx")

    try:
        payload = sys.stdin.read()
        data = json.loads(payload) if payload else {}
    except json.JSONDecodeError as e:
        fail("invalid JSON on stdin: %s" % e)
        return

    try:
        # Imported lazily so the unit suite can exercise the validation
        # branches above without onnxruntime being installed.
        import onnxruntime  # type: ignore
    except ImportError:
        fail("onnxruntime is not installed in this environment", code=3)
        return

    session = onnxruntime.InferenceSession(model_path)

    # Build the input feed: caller's payload keys must match the session's
    # declared inputs. Anything that doesn't is ignored rather than letting
    # an attacker drive arbitrary keyword arguments.
    feed = {}
    for input_meta in session.get_inputs():
        if input_meta.name in data:
            feed[input_meta.name] = data[input_meta.name]

    outputs = session.run(None, feed)
    # Convert numpy arrays to plain lists for JSON serialisation.
    serialisable = []
    for o in outputs:
        if hasattr(o, "tolist"):
            serialisable.append(o.tolist())
        else:
            serialisable.append(o)

    sys.stdout.write(json.dumps(serialisable))


if __name__ == "__main__":
    main()
