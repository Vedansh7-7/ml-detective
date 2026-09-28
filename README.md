# ML Detective

Every dataset is hiding something.

ML Detective is a small data-forensics game. You pick a case, read the story, and get a dataset loaded as `df` in a notebook-style editor in your browser. Somewhere in it is **one planted problem**: an impossible value, a leaky feature, a unit mix-up, a pattern that only shows up across columns. Write whatever pandas / numpy / sklearn / scipy code you like to find it, then type your verdict. Wrong guesses earn sharper hints; right ones go on the leaderboard with your time, steps and tries.

There are 15 cases across three levels:

| Level  | The fault lives in…                                   | Cases |
|--------|-------------------------------------------------------|-------|
| Easy   | one column (`describe()`, `value_counts()` will do)   | 6 |
| Normal | a relationship: a feature vs. the target, time, units | 5 |
| Hard   | structure across columns or inside subgroups          | 4 |

Several are modelled on real-world data mistakes, like spreadsheet software renaming genes, a spacecraft lost to mixed units, and a famous admissions paradox. The explanation after you solve a case says which.

## Run it

Needs Python 3.11+.

```bash
python -m venv .venv
.venv\Scripts\activate          # Windows
# source .venv/bin/activate     # macOS / Linux
pip install -r requirements.txt

python app.py --open
```

It serves on `http://127.0.0.1:5057`. Nothing leaves your machine.

## Play with friends on the same Wi-Fi

```bash
python app.py --lan
```

The terminal prints a LAN address and a six-letter join code. Friends open the address, pick a name, and enter the code. Everyone gets their own notebook; the archive has a live leaderboard, and a toast pops up when someone closes a case. The ✎ Feedback button saves notes to `results/feedback.json` on the host.

On Windows you may need to allow port 5057 through the firewall for your local network:

```powershell
New-NetFirewallRule -DisplayName "ML Detective LAN" -Direction Inbound -Protocol TCP -LocalPort 5057 -RemoteAddress LocalSubnet -Action Allow
```

**Heads-up:** the notebook runs players' code with `exec()` on the host, the same trust model as a Jupyter kernel. Only share the join code with people you trust, and never expose the server to the internet.

## Add your own cases

`STORY_PROMPT.md` is a brief for writing a new case as a JSON "story pack": story, palette, doodle, dataset generator and hidden answer. Drop a pack into `stories_inbox/` and reload the archive. It gets validated (schema, colour contrast, a static screen of the generator code), generated in a separate time-limited process, and filed. Rejected packs land in `stories_inbox/failed/` with a list of what to fix.

You can also file packs without the app running:

```bash
python story_ingest.py
```

## Layout

```
app.py              Flask server + notebook kernel + answer checking
story_ingest.py     story-pack validator / generator
datasets/           <id>.csv, public .meta.json and .story.json per case
secrets/            answers + hints (read only by the server)
static/             frontend (single page, no build step) and case doodles
stories_inbox/      drop new story packs here
```

**Spoiler warning:** `secrets/` holds the answers. Don't open it if you want to play.
