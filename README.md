# ML Detective

Every dataset is hiding something.

ML Detective is a small data-forensics game. You pick a case, read the story, and get a dataset loaded as `df` in a notebook-style editor in your browser. Somewhere in it is **one planted problem**: an impossible value, a leaky feature, a unit mix-up, a pattern that only shows up across columns. Write whatever pandas / numpy / sklearn / scipy code you like to find it, then type your verdict. Wrong guesses earn sharper hints; right ones go on the leaderboard with a score built from your time, cell runs, notebook size, compute time, errors and wrong guesses. 1000 is par for the case; see [docs/SCORING.md](docs/SCORING.md).

There are 15 cases across three levels:

| Level  | The fault lives in…                                   | Cases |
|--------|-------------------------------------------------------|-------|
| Easy   | one column (`describe()`, `value_counts()` will do)   | 6 |
| Normal | a relationship: a feature vs. the target, time, units | 5 |
| Hard   | structure across columns or inside subgroups          | 4 |

Several are modelled on real-world data mistakes, like spreadsheet software renaming genes, a spacecraft lost to mixed units, and a famous admissions paradox. The explanation after you solve a case says which.

## Play in the browser

The web version lives in `web/`: a landing page and the game under `web/play/`. Python runs in the player's browser (Pyodide in a Web Worker), so there is no Python server and nobody's code runs on ours.

Online features use Supabase:

- **Cases** with a shared, ranked board. Verdicts are checked and games timed by the `game` edge function; answers never reach the browser.
- **Weekly Challenge:** a new case each week with its own board. The admin drops it from the Weekly tab (validated in the browser with the same checks as `story_ingest.py`).
- **Stakeout:** race friends on the same case with a room code and a live board.
- **Scout:** after you close a case, read how other detectives cracked it.
- **Upload:** write your own case with the master prompt, play it privately or share a link.

Without the backend the game still plays, with a per-browser board.

To work on it locally:

```bash
python tools/build_web.py                  # export cases + Python modules into web/
python -m http.server 8090 --directory web # then open http://127.0.0.1:8090/
```

`supabase/` holds the schema (`migrations/`) and the edge functions. `tools/build_web.py` also writes `supabase/seed_core.sql` with the core cases' answers; it's gitignored, load it into the database yourself.

## Run it on your machine

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
app.py              Flask server (desktop / LAN version)
kernel.py           the notebook engine, shared by the desktop app and the browser
scoring.py          leaderboard scoring (docs/SCORING.md)
story_ingest.py     story-pack validator / generator
web/                landing page + browser game (web/play), deployed as a static site
supabase/           database schema and edge functions for the online features
tools/build_web.py  exports cases and Python modules into web/
datasets/           <id>.csv, public .meta.json and .story.json per case
secrets/            answers + hints (read only by the server)
static/             frontend (single page, no build step) and case doodles
stories_inbox/      drop new story packs here
```

**Spoiler warning:** `secrets/` holds the answers. Don't open it if you want to play.

## Licence

ML Detective is source-available under the [PolyForm Noncommercial License 1.0.0](LICENSE.md). You're free to read it, run it, learn from it, change it, and use it in teaching or research. Selling it, hosting it as a paid service, or using it in a company or paid course needs a commercial licence. [COMMERCIAL.md](COMMERCIAL.md) spells out what's allowed. The name and brand are not licensed.

## Contributing

Pull requests are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) first: every contribution needs the [contributor agreement](CLA.md). Report security problems privately, as described in [SECURITY.md](SECURITY.md).

## Contact

Vedansh Shrivastava

- Email: vedansh.shrivastavaa@gmail.com
- LinkedIn: [linkedin.com/in/explorerr](https://www.linkedin.com/in/explorerr/)
- GitHub: [@Vedansh7-7](https://github.com/Vedansh7-7)
