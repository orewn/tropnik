"""Lossless ZIP recompression. This module does not sign or publish an APK."""
from __future__ import annotations

import copy
import hashlib
from pathlib import Path
import zipfile


def entry_digests(path: Path) -> dict[str, str]:
    with zipfile.ZipFile(path) as archive:
        names = archive.namelist()
        if len(names) != len(set(names)):
            raise ValueError("Duplicate ZIP entry")
        return {name: hashlib.sha256(archive.read(name)).hexdigest() for name in names}


def repack_lossless(source: Path, destination: Path) -> dict:
    if source.resolve() == destination.resolve():
        raise ValueError("Recompression must preserve its source until verification")
    before = entry_digests(source)
    with zipfile.ZipFile(source) as original, zipfile.ZipFile(destination, "w") as output:
        output.comment = original.comment
        for entry in original.infolist():
            if entry.flag_bits & 1 or entry.compress_type not in {zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED}:
                raise ValueError("Unsupported encrypted or nonstandard APK ZIP entry")
            info = copy.copy(entry)
            # Alignment extra records describe the old byte layout. zipalign
            # regenerates them after compression and before the new signature.
            info.extra = b""
            output.writestr(info, original.read(entry), compress_type=entry.compress_type,
                           compresslevel=9 if entry.compress_type == zipfile.ZIP_DEFLATED else None)
    if entry_digests(destination) != before:
        raise ValueError("Lossless APK entry verification failed")
    return {"zipEntriesVerified": len(before), "allUncompressedEntrySha256Unchanged": True,
            "deflateLevel": 9, "storedEntriesRetainStoredMethod": True}
