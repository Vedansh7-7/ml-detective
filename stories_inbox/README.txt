STORIES INBOX
=============

Drop story packs here: the reply an AI gives you from STORY_PROMPT.md,
saved as a .json, .txt or .md file. Paste it as-is; code fences and
chatter around the JSON are fine.

They're filed automatically the next time the archive loads in the app,
or right away if you run:

    .venv\Scripts\python.exe story_ingest.py

  processed\   packs that became playable cases
  failed\      packs that were rejected, each with a .error.txt listing
               what to fix. Paste that list back to the AI and ask it to
               correct the pack, then drop the new version here.

Don't open packs or .error.txt files before you've played the case:
they contain the answer.

Only drop packs from AIs or people you trust. The pack's Python is
screened and runs in a separate, time-limited process, but that is a
safety net, not a sandbox.
