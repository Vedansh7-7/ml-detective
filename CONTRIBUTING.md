# Contributing

Thanks for wanting to help. Bug fixes, new cases, better hints, accessibility
fixes and docs are all welcome.

## How

1. Open an issue first for anything bigger than a small fix, so we can agree
   on the idea before you spend time on it.
2. Fork the repo, make your change on a branch, and open a pull request
   against `main`.
3. Fill in the pull request template, including the contributor agreement
   checkbox. Pull requests without it can't be merged.

Keep pull requests focused: one change per PR, with a short description of
what it does and how you checked it.

## New cases

`STORY_PROMPT.md` describes the story-pack format. Run
`python story_ingest.py` on your pack and fix everything it reports before
opening a PR. Never put a case's answer anywhere other than its `secret`
block.

## Running it locally

See the README: `python tools/build_web.py`, then serve `web/`.

## What happens to your pull request

ML Detective is maintained by one person and is licensed for
non-commercial use only (see [COMMERCIAL.md](COMMERCIAL.md)). That means:

- **Every contribution needs the [contributor agreement](CLA.md).** You keep
  the copyright in your work; the agreement lets the maintainer ship it in
  ML Detective under any licence, including commercial ones.
- **Merging is at the maintainer's discretion.** A good pull request may
  still be declined if it doesn't fit the product's direction.
- **Credit is at the maintainer's discretion.** Being listed as a
  contributor, and where, is decided case by case. Merged work is always
  kept in the git history under your name.
- **There is no payment** for contributions unless agreed in writing
  beforehand.

## Security issues

Don't open a public issue. See [SECURITY.md](SECURITY.md).
