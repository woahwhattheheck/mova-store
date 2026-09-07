"""Pin checkout/report provenance and compare PR365/369 against their real baseline."""
import hashlib
import json
import os
from pathlib import Path
import subprocess

ROOT = Path(os.environ['GITHUB_WORKSPACE']).resolve()
OUT = ROOT / 'evidence'
OUT.mkdir(exist_ok=True)
REVISIONS = {
    'baseline': '65d9dfb09cbf544edbd0d6ac2954219427f734c7',
    'pr365': '202127cb7d9b4c6764216ea63e200001dbceea63',
    'pr369': '0d3864ed54f6be4cbf5dce4d56bc59894617cca2',
}
ADDED_FILES = {
    'pr365': {'tests/context/CartContext.clearCart.test.tsx': 5},
    'pr369': {
        'tests/app/admin-orders-dispatch-id.test.tsx': 2,
        'tests/lib/resolve-order-id-hash.test.ts': 8,
    },
}


def git(directory, *args):
    return subprocess.check_output(['git', *args], cwd=directory).decode().strip()


def inspect_report(label):
    directory = ROOT / label
    assert git(directory, 'rev-parse', 'HEAD') == REVISIONS[label]
    tracked = set(git(directory, 'ls-files').splitlines())
    report_path = OUT / (label + '.json')
    report = json.loads(report_path.read_text())
    cases, failed_suites, inventory = {}, set(), {}
    for suite in report['testResults']:
        absolute = Path(suite['name'])
        if not absolute.is_absolute():
            absolute = directory / absolute
        relative = absolute.resolve().relative_to(directory).as_posix()
        assert relative in tracked, f'{label}: untracked report path {relative}'
        inventory[relative] = git(directory, 'rev-parse', 'HEAD:' + relative)
        for assertion in suite['assertionResults']:
            key = (relative, assertion['fullName'])
            assert key not in cases, f'duplicate assertion identity: {key}'
            cases[key] = assertion['status']
        if suite['status'] == 'failed':
            failed_suites.add(relative)
    assert cases, f'{label}: empty test report'
    failures = {key for key, status in cases.items() if status == 'failed'}
    assert len(failures) == report['numFailedTests']
    assert len(cases) == report['numTotalTests']
    assert not git(directory, 'diff', '--name-only'), 'Tracked sources changed during validation'
    summary = {
        'head': REVISIONS[label],
        'tree': git(directory, 'rev-parse', 'HEAD^{tree}'),
        'report_sha256': hashlib.sha256(report_path.read_bytes()).hexdigest(),
        'reported_tests': len(cases),
        'passed': sum(status == 'passed' for status in cases.values()),
        'failed': len(failures),
        'failed_test_files': sorted(failed_suites),
        'failed_assertions': sorted(failures),
        'source_manifest': inventory,
    }
    return cases, failures, failed_suites, summary


results = {}
for label in REVISIONS:
    results[label] = inspect_report(label)
base_cases, base_failures, base_suites, _ = results['baseline']
for label, added_files in ADDED_FILES.items():
    cases, failures, suites, summary = results[label]
    assert failures == base_failures, f'{label}: assertion failures differ from baseline'
    assert suites == base_suites, f'{label}: failed test files differ from baseline'
    assert base_cases.keys() <= cases.keys(), f'{label}: baseline tests disappeared'
    added = cases.keys() - base_cases.keys()
    assert len(added) == sum(added_files.values()), f'{label}: wrong additional test count'
    for path, count in added_files.items():
        selected = [key for key in added if key[0] == path]
        assert len(selected) == count, f'{label}: wrong count for {path}'
        assert all(cases[key] == 'passed' for key in selected), f'{label}: added test failed'
    assert {key[0] for key in added} == set(added_files)
    summary['new_tests_passed'] = len(added)
    summary['same_baseline_failures'] = True
    summary['no_baseline_tests_removed'] = True

payload = {label: data[3] for label, data in results.items()}
(OUT / 'verified-summary.json').write_text(json.dumps(payload, indent=2) + '\n')
lines = ['## ASTRA-TEN source-verified frontend comparison', '',
         '| Revision | Passed | Failed | New passing tests |', '|---|---:|---:|---:|']
for label, summary in payload.items():
    lines.append(f"| {label} `{summary['head']}` | {summary['passed']} | {summary['failed']} | {summary.get('new_tests_passed', 0)} |")
lines += ['', 'All reported test paths are tracked at the pinned revision. No baseline test was removed. Both candidate failure sets match baseline exactly. Existing failed/empty suites remain; this is not whole-project green.', '', 'JSON report SHA-256:', '']
for label, summary in payload.items():
    lines.append(f"- {label}: `{summary['report_sha256']}`")
text = '\n'.join(lines) + '\n'
(OUT / 'verified-summary.md').write_text(text)
with open(os.environ['GITHUB_STEP_SUMMARY'], 'a') as target:
    target.write(text)
print(text, flush=True)
