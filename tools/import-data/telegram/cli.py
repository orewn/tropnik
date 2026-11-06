#!/usr/bin/env python3
"""Private discovery -> human review -> validated public references. No network."""
import argparse
from pathlib import Path
import sys

from importer import (ImportFailure, PUBLISHED_PATH, import_export, load_catalog,
                      publish_reviewed, read_json, review_template,
                      validate_published, write_json)

PRIVATE = Path(__file__).resolve().parent / "private"


def private_output(value):
    path = Path(value).resolve()
    if not path.is_relative_to(PRIVATE.resolve()):
        raise ImportFailure("Unreviewed outputs must stay under tools/import-data/telegram/private/")
    return path


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    discover = commands.add_parser("discover", help="Read one chat export into a private review queue")
    discover.add_argument("export", type=Path)
    discover.add_argument("--out", type=Path, default=PRIVATE / "review.queue.json")
    discover.add_argument("--review-template", type=Path, default=PRIVATE / "review-decisions.json")
    discover.add_argument("--previous-queue", type=Path)
    publish = commands.add_parser("publish", help="Apply explicit human review decisions to the public reference JSON")
    publish.add_argument("queue", type=Path)
    publish.add_argument("decisions", type=Path)
    publish.add_argument("--out", type=Path, default=PUBLISHED_PATH)
    validate = commands.add_parser("validate", help="Validate the public reference schema without importing anything")
    validate.add_argument("--input", type=Path, default=PUBLISHED_PATH)
    args = parser.parse_args(argv)
    try:
        catalog = load_catalog()
        if args.command == "discover":
            output, template = private_output(args.out), private_output(args.review_template)
            if output == template or output == args.export.resolve() or template == args.export.resolve():
                raise ImportFailure("Input, queue and review template must be distinct files")
            if template.exists():
                raise ImportFailure("Review template already exists; choose a new --review-template to preserve human decisions")
            queue = import_export(read_json(args.export), catalog,
                                  read_json(args.previous_queue) if args.previous_queue else None)
            write_json(output, queue)
            write_json(template, review_template(queue))
            print(f"Private review candidates: {len(queue['candidates'])}; public routes added: 0")
            print(f"Queue: {output}\nPending review template: {template}")
        elif args.command == "publish":
            output = args.out.resolve()
            if output in {args.queue.resolve(), args.decisions.resolve()}:
                raise ImportFailure("Public output must not overwrite private review inputs")
            previous = read_json(output) if output.exists() else None
            value = publish_reviewed(read_json(args.queue), read_json(args.decisions), catalog, previous)
            write_json(output, value)
            print(f"Validated public references: {len(value['routes'])} new routes; {len(value['sourcesByRouteId'])} routes with reviewed sources")
            print(f"Output: {output}")
        else:
            value = validate_published(read_json(args.input), catalog)
            print(f"Valid: {value['status']}; {len(value['routes'])} Telegram routes; {len(value['sourcesByRouteId'])} source mappings")
    except (ImportFailure, OSError, TimeoutError) as error:
        # Do not echo malformed message bodies, attachment paths, contacts or
        # subprocess output into CI logs. ImportFailure messages are constants.
        print(f"Telegram import stopped: {error if isinstance(error, ImportFailure) else type(error).__name__}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
