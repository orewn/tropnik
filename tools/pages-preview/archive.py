"""Deterministic archive of the deployable static output, with no source workspace files."""
from pathlib import Path
from zipfile import ZipFile, ZipInfo, ZIP_DEFLATED
import sys

root, target = map(Path, sys.argv[1:3])
with ZipFile(target, 'w', compression=ZIP_DEFLATED, compresslevel=9) as archive:
    for path in sorted(root.rglob('*')):
        if not path.is_file():
            continue
        info = ZipInfo(path.relative_to(root).as_posix(), (1980, 1, 1, 0, 0, 0))
        info.compress_type = ZIP_DEFLATED
        info.external_attr = 0o100644 << 16
        archive.writestr(info, path.read_bytes(), compresslevel=9)
print(f'Static archive: {target} ({target.stat().st_size} bytes)')
