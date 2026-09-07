#!/usr/bin/env python3
"""Finite, isolated before/after replay for the Mova Toast lifecycle repair.

Install the repository lockfile with npm ci, then run:
    python3 review-tests/toast_lifecycle_replay.py --output /tmp/toast-evidence

Run only in a disposable checkout. The original component is temporarily copied
from the recorded base, while the same new regression tests exercise both versions.
No server, database, wallet, external payment, or deployed application is used.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys

BASE = "65d9dfb09cbf544edbd0d6ac2954219427f734c7"
CANDIDATE = "3f4cfaea7e7475d24b6cbe19ce6149a9eb031d50"
SOURCE = "components/Toast.jsx"
TEST = "tests/components/Toast.test.jsx"
EXPECTED_TESTS = 15


def git(*args: str) -> bytes:
    return subprocess.check_output(["git", *args])


def blob(data: bytes) -> str:
    return hashlib.sha1(f"blob {len(data)}\0".encode() + data).hexdigest()


def run(argv: list[str], label: str, output: Path) -> dict:
    environment = os.environ.copy()
    environment["CI"] = "true"
    environment["NEXT_TELEMETRY_DISABLED"] = "1"
    outcome = subprocess.run(argv, env=environment, capture_output=True,
                             text=True, timeout=300, check=False)
    log = output / f"{label}.log"
    log.write_text("COMMAND " + json.dumps(argv) + "\n" + outcome.stdout
                   + "\nSTDERR\n" + outcome.stderr
                   + f"\nEXIT {outcome.returncode}\n", encoding="utf-8")
    print(f"{label}: exit={outcome.returncode}", flush=True)
    return {"command": argv, "exit": outcome.returncode, "log": log.name,
            "stdout": outcome.stdout, "stderr": outcome.stderr}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    if (output / "results.json").exists():
        raise RuntimeError("Refusing to overwrite existing replay results")
    report = {"base": BASE, "candidate_before_native_formatting": CANDIDATE,
              "runner_commit": git("rev-parse", "HEAD").decode().strip(),
              "platform": platform.platform(), "complete": False,
              "scope": "15 native React fake-timer regressions; not full suite or browser QA"}
    restored = {}
    status = 1
    try:
        changed = git("diff", "--name-only", BASE, CANDIDATE).decode().splitlines()
        if sorted(changed) != sorted([SOURCE, TEST]):
            raise RuntimeError(f"Unexpected candidate scope: {changed!r}")
        for path in (SOURCE, TEST):
            expected = git("show", f"{CANDIDATE}:{path}")
            if Path(path).read_bytes() != expected:
                raise RuntimeError(f"Checkout differs from candidate: {path}")
        report["node"] = subprocess.check_output(["node", "--version"], text=True).strip()
        report["npm"] = subprocess.check_output(["npm", "--version"], text=True).strip()
        report["versions"] = {
            name: json.loads((Path("node_modules") / name / "package.json").read_text())["version"]
            for name in ("react", "react-dom", "vitest", "typescript", "prettier")
        }
        report["lockfile_sha256"] = hashlib.sha256(Path("package-lock.json").read_bytes()).hexdigest()
        formatted = run(["node_modules/.bin/prettier", "--write", SOURCE, TEST], "native-format", output)
        report["native_format"] = formatted
        if formatted["exit"]:
            raise RuntimeError("Native formatting failed")
        for path in (SOURCE, TEST):
            restored[path] = Path(path).read_bytes()
            target = output / "candidate" / path
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(restored[path])
        report["tested_blobs"] = {path: blob(data) for path, data in restored.items()}
        report["tested_sha256"] = {path: hashlib.sha256(data).hexdigest() for path, data in restored.items()}
        report["base_source_blob"] = blob(git("show", f"{BASE}:{SOURCE}"))
        report["cases"] = {}
        for label, data in (("base", git("show", f"{BASE}:{SOURCE}")),
                            ("candidate", restored[SOURCE])):
            Path(SOURCE).write_bytes(data)
            json_path = output / f"{label}-vitest.json"
            tests = run(["node_modules/.bin/vitest", "run", TEST, "--reporter=json",
                         f"--outputFile={json_path}", "--pool=threads",
                         "--poolOptions.threads.singleThread"], f"{label}-vitest", output)
            parsed = json.loads(json_path.read_text(encoding="utf-8"))
            assertions = [case for suite in parsed["testResults"]
                          for case in suite.get("assertionResults", [])]
            types = run(["npm", "run", "type-check", "--", "--incremental", "false"],
                        f"{label}-typecheck", output)
            report["cases"][label] = {
                "source_blob": blob(data), "test_blob": blob(restored[TEST]),
                "test_exit": tests["exit"], "total": len(assertions),
                "passed": sum(c["status"] == "passed" for c in assertions),
                "failed": sum(c["status"] == "failed" for c in assertions),
                "assertions": [{"name": c["fullName"], "status": c["status"],
                                "failure_messages": c.get("failureMessages", [])}
                               for c in assertions], "typecheck": types}
        Path(SOURCE).write_bytes(restored[SOURCE])
        lint = run(["node_modules/.bin/eslint", SOURCE, TEST], "candidate-focused-lint", output)
        style = run(["node_modules/.bin/prettier", "--check", SOURCE, TEST], "candidate-format-check", output)
        report["focused_lint"] = lint
        report["format_check"] = style
        base = report["cases"]["base"]
        candidate = report["cases"]["candidate"]
        base_types = base["typecheck"]["stdout"] + base["typecheck"]["stderr"]
        candidate_types = candidate["typecheck"]["stdout"] + candidate["typecheck"]["stderr"]
        checks = {
            "same_complete_regressions": base["total"] == candidate["total"] == EXPECTED_TESTS,
            "original_defect_detected": base["test_exit"] != 0 and base["failed"] > 0,
            "candidate_regressions_pass": candidate["test_exit"] == 0 and candidate["passed"] == EXPECTED_TESTS,
            "original_jsx_syntax_error_detected": "TS8010" in base_types and SOURCE in base_types,
            "no_toast_type_errors_after_fix": SOURCE + "(" not in candidate_types and TEST + "(" not in candidate_types,
            "focused_lint_pass": lint["exit"] == 0,
            "native_format_pass": style["exit"] == 0,
        }
        report["checks"] = checks
        report["full_typecheck_pass"] = candidate["typecheck"]["exit"] == 0
        report["pass"] = all(checks.values())
        report["complete"] = True
        (output / "toast-lifecycle.patch").write_bytes(git("diff", BASE, "--", SOURCE, TEST))
        status = 0 if report["pass"] else 1
    except (OSError, subprocess.SubprocessError, RuntimeError, ValueError, KeyError) as error:
        report["error"] = str(error)
        report["pass"] = False
        print(str(error), file=sys.stderr)
    finally:
        for path, data in restored.items():
            Path(path).write_bytes(data)
        (output / "results.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
        shutil.copyfile(Path(__file__), output / Path(__file__).name)
        print(json.dumps({"complete": report["complete"], "pass": report.get("pass", False),
                          "checks": report.get("checks", {}),
                          "full_typecheck_pass": report.get("full_typecheck_pass")}), flush=True)
    return status


if __name__ == "__main__":
    raise SystemExit(main())
