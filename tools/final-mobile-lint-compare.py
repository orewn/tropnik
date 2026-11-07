#!/usr/bin/env python3
from collections import Counter
from pathlib import Path
import json
import sys


def findings(path: Path) -> Counter[tuple[str,str,int]]:
    payload=json.loads(path.read_text() or '[]')
    result:Counter[tuple[str,str,int]]=Counter()
    for report in payload:
        raw=Path(report.get('filePath','')).as_posix()
        name=raw.split('/web/',1)[-1] if '/web/' in raw else raw
        for item in report.get('messages',[]):
            # React lint embeds line excerpts in the prose. A harmless line
            # shift must not look like a new finding; file + rule + severity
            # plus occurrence count is the stable regression identity.
            result[(name,str(item.get('ruleId') or 'parser'),int(item.get('severity') or 0))]+=1
    return result

before=findings(Path(sys.argv[1]))
after=findings(Path(sys.argv[2]))
added=after-before
Path(__file__).unlink()
if added:
    for (file,rule,severity),count in sorted(added.items()):
        print(f'NEW {count}× severity={severity} {file} {rule}',file=sys.stderr)
    raise SystemExit('Release introduces new lint findings relative to main')
print(f'Lint baseline preserved: {sum(before.values())} existing findings, no additions')
