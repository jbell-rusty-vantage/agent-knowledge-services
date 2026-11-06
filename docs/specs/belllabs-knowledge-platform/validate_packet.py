"""Validate this planning packet, not application implementation or deployment."""
from __future__ import annotations

import json
import re
from pathlib import Path


def validate() -> dict:
    packet = Path(__file__).resolve().parent
    root = packet.parents[2]
    plan = json.loads((packet / 'issues.json').read_text(encoding='utf-8'))
    issues = plan['issues']
    ids = {item['id'] for item in issues}
    assert len(ids) == len(issues) == 60, 'Unexpected or duplicate issue set'
    assert {f'Q{i:02}' for i in range(1, 5)} <= ids, 'Missing owner decision gate'
    assert {f'G{i:02}' for i in range(9)} <= ids, 'Missing GraphQL/client slice'
    assert {f'N{i:02}' for i in range(1, 6)} <= ids, 'Missing native retrieval/ingestion slice'
    assert {f'V{i:02}' for i in range(1, 15)} <= ids, 'Missing mandatory verification slice'
    assert 'V15' not in ids and any('V15' in entry for entry in plan['deferred'])
    completed: set[str] = set()
    for item in issues:
        assert set(item['depends']) <= completed, f"Non-topological/unknown blockers: {item['id']}"
        assert len(item['depends']) == len(set(item['depends'])), 'Duplicate blocker'
        assert item['criteria'] and item['owner'] and item['adrs']
        assert item['implementationState'] == 'not_started', 'Planning must not claim implementation'
        assert item['status'] in ('ready-for-agent', 'ready-for-human', 'needs-info')
        if item['id'].startswith('Q'):
            assert item['status'] == 'ready-for-human', 'Owner decision must remain human-gated'
        issue_file = packet / 'issues' / f"{item['order']:02d}-{item['id'].lower()}.md"
        body = issue_file.read_text(encoding='utf-8')
        for section in ('## What to build', '## Acceptance criteria', '## Testing seam', '## Out of scope', '## Provenance'):
            assert section in body, f'Missing issue section: {issue_file.name} {section}'
        completed.add(item['id'])
    final = next(item for item in issues if item['id'] == 'F99')
    readiness = next(item for item in issues if item['id'] == 'D10')
    assert set(final['depends']) == ids - {'F99'}, 'Final gate lacks a mandatory blocker'
    assert set(readiness['depends']) == ids - {'F99', 'D10'}, 'Readiness gate lacks implementation blocker'
    by_id = {item['id']: item for item in issues}
    assert 'Q01' in by_id['V07']['depends'] and by_id['V07']['status'] == 'needs-info'
    assert 'Q02' in by_id['N01']['depends'] and 'Q03' in by_id['N04']['depends']
    assert 'G05' in by_id['P02']['depends'] and 'G07' in by_id['D07']['depends']

    files = list(packet.rglob('*.md')) + [root / 'GLOSSARY.md']
    files += [root / 'docs/agents' / name for name in ('issue-tracker.md', 'triage-labels.md', 'domain.md')]
    adrs = [p for p in (root / 'docs/architecture').glob('00*.md') if 5 <= int(p.name[:4]) <= 15]
    assert len(adrs) == 11
    files += adrs
    links = 0
    broken = []
    for file in files:
        text = file.read_text(encoding='utf-8')
        # Code examples may contain illustrative link syntax; inspect actual prose only.
        text = re.sub(r'```.*?```', '', text, flags=re.S)
        for target in re.findall(r'\[[^\]]*\]\(([^)]+)\)', text):
            target = target.strip('<>').split('#', 1)[0]
            if not target or re.match(r'^[a-zA-Z]+://', target):
                continue
            links += 1
            if not (file.parent / target).resolve().exists():
                broken.append(f'{file.relative_to(root)} -> {target}')
    assert not broken, 'Broken local links:\n' + '\n'.join(broken)
    for name in ('to-spec', 'to-tickets', 'triage', 'setup-matt-pocock-skills'):
        skill = root / '.agents/skills' / name / 'SKILL.md'
        assert skill.is_file() and f'name: {name}' in skill.read_text(encoding='utf-8')

    linear_file = packet / 'LINEAR.json'
    if linear_file.exists():
        linear = json.loads(linear_file.read_text(encoding='utf-8'))
        assert set(linear['issues']) == ids
        assert len(linear['documents']) == 9 and len(linear['milestones']) == 7
        assert linear['dependencyCount'] == sum(len(item['depends']) for item in issues)
        assert all(record['url'].startswith('https://linear.app/overtonbell/') for record in linear['issues'].values())
    return {'issues':len(issues), 'adrs':len(adrs), 'dependency_edges':sum(len(item['depends']) for item in issues), 'final_direct_blockers':len(final['depends']), 'markdown_files':len(files), 'local_links':links, 'skills':4, 'linear_register_present':linear_file.exists(), 'application_fixtures_run':False}


if __name__ == '__main__':
    print(json.dumps(validate(), indent=2))
