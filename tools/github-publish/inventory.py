#!/usr/bin/env python3
"""Read-only Git blob inventory and deterministic Git Database API payloads.

No network calls, git mutations, credentials, or source-file writes are performed.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
from pathlib import Path
import re
import stat
import subprocess
import sys

PARENT = '7ddf2da8fac7f51c1ea3e6b37d0583eacaf81d59'
EXCLUDED_DIRS = {
    '.git', 'node_modules', '.next', '.nuxt', '.vinext', '.wrangler',
    '.sites-runtime', '.gradle', '.kotlin', '.cache', 'cache', 'caches',
    'raw', 'build', 'dist', 'target', 'coverage', '.stage', '__pycache__',
    '.pytest_cache', '.mypy_cache', '.venv', 'venv', '.idea', 'tmp', 'temp',
    'outputs', 'work', 'credentials', 'secrets', '.secrets',
}
EXCLUDED_SUFFIXES = {
    '.apk', '.aab', '.apks', '.zip', '.tar', '.tgz', '.gz', '.bundle',
    '.jks', '.keystore', '.p12', '.pfx', '.pem', '.key', '.sqlite',
    '.sqlite3', '.db', '.pyc', '.class', '.log', '.tsbuildinfo',
}
SECRET_NAMES = {'.npmrc', '.netrc', '.git-credentials', 'credentials.json',
                'credentials.yaml', 'credentials.yml', 'local.properties'}
SECRET_PATTERNS = (
    re.compile(r'-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----'),
    re.compile(r'\bgh[pousr]_[A-Za-z0-9]{36,}\b'),
    re.compile(r'\bgithub_pat_[A-Za-z0-9_]{50,}\b'),
    re.compile(r'\b(?:AKIA|ASIA)[A-Z0-9]{16}\b'),
)


def encode(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':')).encode('utf-8')


def blob_sha(data):
    return hashlib.sha1(b'blob ' + str(len(data)).encode('ascii') + b'\0' + data).hexdigest()


def text_value(data):
    try:
        text = data.decode('utf-8')
    except UnicodeDecodeError:
        return None
    if any(ord(char) < 32 and char not in '\t\n\r' for char in text):
        return None
    return text


def exclusion(path):
    pieces = path.parts
    if path.as_posix().startswith(('tools/github-publish/generated/', 'tools/db-compat/.work/')):
        return 'rebuildable-verification-transport'
    if any(piece.lower() in EXCLUDED_DIRS for piece in pieces[:-1]):
        return 'raw-cache-build-or-private-directory'
    name = path.name.lower()
    if name in SECRET_NAMES or name.startswith(('id_rsa', 'id_ed25519', 'service-account')):
        return 'credential-or-machine-local-file'
    if name == '.env' or name.startswith('.env.') and not name.endswith(('.example', '.sample', '.template')):
        return 'environment-secrets-file'
    if path.suffix.lower() in EXCLUDED_SUFFIXES:
        return 'release-cache-or-private-file'
    return None


def all_paths(root):
    # rg is fast and includes the deliberately committed configuration files.
    result = subprocess.run(['rg', '--files', '--hidden', '--no-ignore', str(root)],
                            capture_output=True, text=True, check=True)
    return sorted((Path(line) for line in result.stdout.splitlines()),
                  key=lambda path: path.relative_to(root).as_posix())


def read_checked(root, entry):
    path = root / entry['path']
    if path.is_symlink() or not path.resolve().is_relative_to(root.resolve()):
        raise ValueError(f"Source path escaped its snapshot: {entry['path']}")
    data = path.read_bytes()
    if len(data) != entry['bytes'] or blob_sha(data) != entry['gitBlobSha']:
        raise ValueError(f"Snapshot changed since inventory: {entry['path']}")
    return data


def tree_entry(entry, content=None):
    value = {'path': entry['path'], 'mode': entry['mode'], 'type': 'blob'}
    value['sha' if content is None else 'content'] = entry['gitBlobSha'] if content is None else content
    return value


def emit_slice(data, args):
    """A UTF-8-safe byte window, packaged as JSON for tool-result assembly."""
    if args.offset < 0 or args.offset > len(data):
        raise ValueError('offset must be inside the payload or exactly at its end')
    if not 1024 <= args.limit <= 262144:
        raise ValueError('limit must be between 1024 and 262144 bytes')
    piece = data[args.offset:args.offset + args.limit]
    try:
        text = piece.decode('utf-8')
    except UnicodeDecodeError as error:
        if error.reason != 'unexpected end of data' or error.end != len(piece):
            raise ValueError('offset is not a UTF-8 boundary; use the previous nextOffset') from error
        piece = piece[:error.start]
        text = piece.decode('utf-8')
    value = {'format': 'utf8-json-slice', 'offset': args.offset, 'bytesRead': len(piece),
             'nextOffset': args.offset + len(piece), 'totalBytes': len(data),
             'end': args.offset + len(piece) == len(data),
             'payloadSha256': hashlib.sha256(data).hexdigest(), 'text': text}
    output = encode(value) + b'\n'
    if args.stdout:
        sys.stdout.buffer.write(output)
    else:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_bytes(output)
        print(json.dumps({'payloadSlice': str(args.out), 'offset': value['offset'],
                          'nextOffset': value['nextOffset'], 'end': value['end']}))


def read_payload(args):
    emit_slice(args.file.read_bytes(), args)


def inventory(args):
    root = args.source.resolve()
    known = set()
    if args.known_blobs:
        value = json.loads(args.known_blobs.read_text())
        if isinstance(value, dict):
            if value.get('truncated'):
                raise ValueError('Known Git tree is truncated; provide complete blob SHAs')
            value = [entry['sha'] for entry in value['tree'] if entry.get('type') == 'blob']
        if not isinstance(value, list) or any(not isinstance(sha, str) or not re.fullmatch('[0-9a-f]{40}', sha) for sha in value):
            raise ValueError('known-blobs must be a SHA array or a complete Git Trees API response')
        known = set(value)
    entries, excluded, groups = [], [], {}
    total_bytes = total_files = 0
    for path in all_paths(root):
        relative = path.relative_to(root)
        info = path.lstat()
        if not stat.S_ISREG(info.st_mode):
            excluded.append({'path': relative.as_posix(), 'bytes': info.st_size, 'reason': 'non-regular-file'})
            continue
        total_files += 1
        total_bytes += info.st_size
        reason = exclusion(relative)
        if reason:
            excluded.append({'path': relative.as_posix(), 'bytes': info.st_size, 'reason': reason})
            continue
        data = path.read_bytes()
        text = text_value(data)
        if text is not None and any(pattern.search(text) for pattern in SECRET_PATTERNS):
            excluded.append({'path': relative.as_posix(), 'bytes': len(data), 'reason': 'credential-pattern-review-required'})
            continue
        # The Gradle wrapper JAR is an ordinary readable blob, never an executable.
        mode = '100755' if info.st_mode & 0o111 and path.suffix.lower() != '.jar' else '100644'
        entry = {'path': relative.as_posix(), 'bytes': len(data), 'gitBlobSha': blob_sha(data),
                 'sha256': hashlib.sha256(data).hexdigest(), 'kind': 'text' if text is not None else 'binary', 'mode': mode}
        entries.append(entry)
        if entry['gitBlobSha'] not in groups:
            groups[entry['gitBlobSha']] = {**entry, 'paths': [entry['path']]}
        else:
            groups[entry['gitBlobSha']]['paths'].append(entry['path'])
    unique = sorted(groups.values(), key=lambda value: value['path'])
    chunks, current, current_size, blob_uploads = [], [], len(encode({'tree': []})), []
    for entry in unique:
        if entry['gitBlobSha'] in known:
            continue
        text = text_value(read_checked(root, entry)) if entry['kind'] == 'text' else None
        inline_bytes = len(encode(tree_entry(entry, text))) if text is not None else None
        if inline_bytes is None or inline_bytes + len(encode({'tree': []})) > args.chunk_bytes:
            blob_uploads.append(entry['gitBlobSha'])
            continue
        addition = inline_bytes + (1 if current else 0)
        if current and current_size + addition > args.chunk_bytes:
            chunks.append({'index': len(chunks), 'gitBlobShas': current, 'requestBytes': current_size})
            current, current_size = [], len(encode({'tree': []}))
            addition = inline_bytes
        current.append(entry['gitBlobSha'])
        current_size += addition
    if current:
        chunks.append({'index': len(chunks), 'gitBlobShas': current, 'requestBytes': current_size})
    final_tree_bytes = len(encode({'tree': [tree_entry(entry) for entry in entries]}))
    counts = lambda rows: {'files': len(rows), 'bytes': sum(row['bytes'] for row in rows)}
    summary = {
        'baseline': {'files': total_files, 'bytes': total_bytes},
        'publish': counts(entries), 'excluded': counts(excluded),
        'uniqueBlobs': counts(unique),
        'uniqueText': counts([entry for entry in unique if entry['kind'] == 'text']),
        'uniqueBinary': counts([entry for entry in unique if entry['kind'] == 'binary']),
        'duplicatePathCount': len(entries) - len(unique),
        'deduplicatedBytes': sum(entry['bytes'] for entry in entries) - sum(entry['bytes'] for entry in unique),
        'textTreeCalls': len(chunks), 'blobCalls': len(blob_uploads),
        'largeTextBlobCalls': sum(groups[sha]['kind'] == 'text' for sha in blob_uploads),
        'reusedExistingBlobCount': sum(entry['gitBlobSha'] in known for entry in unique),
        'maxBlobPayloadBytes': max((len(encode({'content': '', 'encoding': 'base64'})) + 4 * ((groups[sha]['bytes'] + 2) // 3) for sha in blob_uploads), default=0),
        'finalTreeRequestBytes': final_tree_bytes,
        'maxTextTreeRequestBytes': max((chunk['requestBytes'] for chunk in chunks), default=0),
        'estimatedObjectWriteCalls': len(chunks) + len(blob_uploads) + 1,
        'largestPublishFiles': sorted(entries, key=lambda entry: entry['bytes'], reverse=True)[:12],
    }
    manifest = {'schemaVersion': 1, 'sourceRoot': str(root), 'parentCommit': args.parent,
                'textChunkBytes': args.chunk_bytes, 'summary': summary,
                'knownGitBlobShas': sorted(known),
                'textTreeChunks': chunks, 'blobUploads': blob_uploads,
                'entries': entries, 'uniqueBlobs': unique, 'excluded': excluded}
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_bytes(encode(manifest) + b'\n')
    print(json.dumps({'inventory': str(args.out), 'summary': summary}, ensure_ascii=False, indent=2))


def extract(args):
    manifest = json.loads(args.inventory.read_text())
    root = (args.source or Path(manifest['sourceRoot'])).resolve()
    unique = {entry['gitBlobSha']: entry for entry in manifest['uniqueBlobs']}
    expected_sha = None
    if args.kind == 'text-tree':
        chunk = manifest['textTreeChunks'][args.chunk]
        rows = []
        for sha in chunk['gitBlobShas']:
            entry = unique[sha]
            rows.append(tree_entry(entry, read_checked(root, entry).decode('utf-8')))
        payload = {'tree': rows}
        data = encode(payload)
        if len(data) != chunk['requestBytes'] or len(data) > manifest['textChunkBytes']:
            raise ValueError('Text payload size does not match its deterministic chunk plan')
    elif args.kind == 'blob':
        if args.sha not in manifest['blobUploads']:
            raise ValueError('Choose a SHA listed in blobUploads')
        data = encode({'content': base64.b64encode(read_checked(root, unique[args.sha])).decode('ascii'), 'encoding': 'base64'})
        expected_sha = args.sha
    else:
        # All referenced blobs must exist before submitting this final tree.
        payload = {'tree': [tree_entry(entry) for entry in manifest['entries']]}
        if args.base_tree:
            if not re.fullmatch('[0-9a-f]{40}', args.base_tree):
                raise ValueError('base-tree must be a Git tree SHA, not a branch name')
            payload['base_tree'] = args.base_tree
        data = encode(payload)
    if args.stdout:
        emit_slice(data, args)
    else:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_bytes(data)
        print(json.dumps({'payload': str(args.out), 'bytes': len(data),
                          'sha256': hashlib.sha256(data).hexdigest(), 'expectedGitBlobSha': expected_sha}, indent=2))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    scan = commands.add_parser('inventory')
    scan.add_argument('--source', type=Path, required=True)
    scan.add_argument('--out', type=Path, required=True)
    scan.add_argument('--parent', default=PARENT)
    scan.add_argument('--chunk-bytes', type=int, default=400_000)
    scan.add_argument('--known-blobs', type=Path)
    scan.set_defaults(run=inventory)
    get = commands.add_parser('extract')
    get.add_argument('--inventory', type=Path, required=True)
    get.add_argument('--source', type=Path)
    get.add_argument('--kind', choices=['text-tree', 'blob', 'final-tree'], required=True)
    get.add_argument('--chunk', type=int, default=0)
    get.add_argument('--sha')
    get.add_argument('--base-tree')
    output = get.add_mutually_exclusive_group(required=True)
    output.add_argument('--out', type=Path)
    output.add_argument('--stdout', action='store_true')
    get.add_argument('--offset', type=int, default=0)
    get.add_argument('--limit', type=int, default=65536)
    get.set_defaults(run=extract)
    read = commands.add_parser('read-payload')
    read.add_argument('--file', type=Path, required=True)
    read.add_argument('--offset', type=int, default=0)
    read.add_argument('--limit', type=int, default=65536)
    output = read.add_mutually_exclusive_group(required=True)
    output.add_argument('--stdout', action='store_true')
    output.add_argument('--out', type=Path)
    read.set_defaults(run=read_payload)
    args = parser.parse_args()
    if hasattr(args, 'chunk_bytes') and not 1024 <= args.chunk_bytes <= 400_000:
        parser.error('chunk-bytes must be between 1024 and 400000')
    args.run(args)


if __name__ == '__main__':
    main()
