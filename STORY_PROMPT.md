# ML Detective — Master Prompt for New Cases

> **How to use this file (for you, the player)**
> 1. Fill in the **BRIEF** below: difficulty, and optionally a setting.
> 2. Copy everything from `=== PROMPT START ===` to `=== PROMPT END ===` and paste it into any AI chat.
> 3. Save the AI's reply as a file in `GopiBehen/stories_inbox/` with any name ending in `.json`, `.txt` or `.md`.
>    Paste the reply as it came. A ```` ```json ```` fence or a sentence before or after the JSON is fine.
> 4. Open or reload the archive in the app. The case is checked and generated, then appears in the archive, or you see a red REJECTED notice.
>    Rejected packs go to `stories_inbox/failed/` with a `.error.txt` file next to them. Paste that file back to the same AI and ask it to fix the pack.
>
> **Don't read the AI's reply before playing.** It contains the answer. Save it without reading. The same goes for the `.error.txt` files.

---

=== PROMPT START ===

## BRIEF

- **Difficulty:** `easy`   ← change to `easy`, `normal` or `hard`
- **Setting / theme (optional):** _(leave blank to let the AI choose. Examples: "a night bus company", "a beekeeping co-op", "a Martian greenhouse")_
- **Avoid (optional):** _(themes you've already played or don't want)_

---

## Your role

You are designing one case for **ML Detective**, a local data-forensics game. A player gets a dataset and a short story, then writes their own Python (pandas, numpy, matplotlib, seaborn, scikit-learn, scipy) in a notebook to find **the one planted problem** in the data. They type a short answer. A correct answer closes the case and records their time. A wrong answer earns the next hint.

You write the whole case: the story, a small doodle, the dataset's public description, the hidden answer with hints, and Python code that generates the data. Your reply is a single JSON **story pack**. A program on the player's machine validates it strictly and files it automatically, so the format rules below are exact.

## What makes a good case

1. **Exactly one planted fault.** Everything else in the data is realistic and clean: plausible distributions, sensible rounding, believable correlations. For `normal` and `hard` cases you may add one harmless red herring, such as a legitimately skewed column. It must not be in the accepted answers.
2. **The fault can be found with data analysis, not guessed from the story.** The story sets the mood and gives, at most, one atmospheric clue. It never names the column or the kind of fault.
3. **Match the difficulty:**

| Level | The fault… | The player should need… | Examples (invent your own too) |
|---|---|---|---|
| `easy` | lives in **one column** and is obvious once you look at the right summary | `df.describe()`, `value_counts()`, `isna().sum()`, one histogram | impossible values (negative weights, a 400-year-old person); a sentinel like `-999` or `9999` hiding in a numeric column; the same value typed in several spellings (`"NY"`, `"N.Y."`, `"new york"`); duplicated IDs that should be unique; a column that is constant or almost constant |
| `normal` | is a **relationship** between a column and something else | a correlation, a `groupby` against the target, a scatter plot, or a trend over time | target leakage (a feature computed from the target); a column that is just a rescaled copy of another; a unit switch partway through (Celsius to Fahrenheit after a date); one category whose labels were swapped; a sudden level shift after a date |
| `hard` | only shows up when you look at **several columns together** or at structure. Every single-column summary looks normal | multi-column duplicate detection, clustering, residuals from a model, looking within subgroups, spectral or periodic analysis | a small cluster of near-identical rows across all numeric columns; a relationship that reverses inside one subgroup (Simpson's paradox); label noise concentrated in one segment; a periodic signal buried in noise; one region's numbers too uniform to be real (fabricated) |

4. **Size:** 300–3,000 rows and 4–12 columns. It's usually good to include an ID column. Store dates as ISO strings (`"2024-03-01"`), not datetime objects.
5. **The player wins by typing either the target column's name or any accepted answer** (details under `secret`). So for a `hard` case, choose `target_column` so that naming it genuinely pins down the fault, for example the ID of the one device that is misbehaving.

## Output format: the story pack

Reply with **one JSON object and nothing else**. Keys:

```
{
  "id":        string   lowercase letters, digits and _, 3–60 chars, e.g. "normal_night_bus_ledger_7k2".
                         Start with the level and end with a few random characters so it's unique.
  "level":     "easy" | "normal" | "hard"      (must match the BRIEF)

  "story": {
    "title":     string   3–7 words, evocative, no spoilers
    "hook":      string   one sentence, at most 140 characters, shown on the archive card
    "narrative": [string, string, string]
                 2–5 paragraphs, each 40–90 words. Give named characters, a concrete place and
                 a stake. The last paragraph hands the player the mission. Never mention the
                 target column's name (with or without underscores) or name the fault type.
    "palette": {
      "bg": "#rrggbb",  "surface": "#rrggbb",  "ink": "#rrggbb",  "muted": "#rrggbb",
      "accent": "#rrggbb",  "accent2": "#rrggbb",  "note": "#rrggbb",  "note_ink": "#rrggbb"
    }
  },

  "meta": {
    "title":       string   plain dataset name, e.g. "Night Bus Fare Log"
    "description": string   2–3 sentences for the player's case notes: what the data is, and
                            the task ("One thing in this export can't be trusted. Find it.")
    "columns":     { "<column name>": "<type and meaning>", ... }
                   EXACTLY the columns generate() produces, in the same order. Describe them
                   honestly but neutrally; don't flag the faulty one.
  },

  "secret": {
    "fault_type":       string   short snake_case label, e.g. "sentinel_values", "target_leakage"
    "target_column":    string   the column at the heart of the fault (must exist in the data)
    "description":      string   2–4 sentences shown AFTER the player wins: what was planted,
                                 and which analysis reveals it
    "accepted_answers": [string, ...]   at least 3 short phrasings that each prove the player
                                        found it (see matching rules below)
    "hints":            [string, string, string]   exactly 3, vaguest first:
                        1. which kind of analysis to try, without naming the column
                        2. narrows it to the right column or relationship
                        3. all but gives it away
  },

  "data": {
    "seed": integer,
    "code": string, or a list of strings (one per line). Python source defining
            generate(rng) and check(df). See the code rules.
  },

  "doodle_svg": string, or a list of strings (one per line). See the doodle rules.
}
```

### How answers are matched

The game lowercases the player's guess, turns `_` into spaces, strips punctuation and drops filler words (*the, a, an, column, columns, field, value, values, is, are, in, of, there, has, have, problem, issue, hidden, fault, feature, data, row, rows*). A guess is correct if it contains **every remaining word** of at least one accepted answer. `target_column` always counts as an accepted answer too.

So make each accepted answer the **shortest phrase that proves understanding**, and never a lone generic word:
- ✅ `"sensor 17"`, `"fare_amount"`, `"duplicate ticket ids"`, `"celsius fahrenheit switch"`
- ❌ `"outliers"` or `"leakage"`: any guess containing that one word would win, even with the wrong column
- ❌ long sentences: the player would have to type every word

### Code rules (`data.code`)

- Define **`generate(rng)`**. `rng` is a `numpy.random.Generator` built from `data.seed`. Use it for **all** randomness. Return a `pandas.DataFrame`.
- Define **`check(df)`**. Return `True` when the planted fault is present in `df`, otherwise `False`. It runs twice: on your DataFrame, and again on the CSV the player will load (`pd.read_csv` of your saved data). Write it against the CSV version: dates are strings, categories are plain text, and floats are only as precise as you rounded them.
  Make it a real test of the fault, e.g. "at least 5 rows have age > 120" or "the correlation between X and the target is above 0.95". A check that always returns `True` defeats the point.
- `np` (numpy) and `pd` (pandas) are already available. The only other modules you may import are `math`, `random`, `string`, `datetime`, `itertools`, `collections`, `statistics` and `functools`.
- **Forbidden**, and the pack is rejected if any appear: file, network or OS access; `open`, `eval`, `exec`, `compile`, `getattr`, `globals` and similar; any `__dunder__` attribute; pandas and numpy readers and writers (`read_*`, `to_csv`, `to_json`, `np.save` and the like). The program saves the data itself.
- It must run in under 60 seconds. Prefer vectorised numpy over Python loops for anything large.
- Keep it readable: short, plain functions, with a comment where the fault is planted. Use **single quotes** for Python strings so the JSON needs fewer escapes. If escaping gets awkward, give `code` as a list of lines.

### Palette rules

The palette themes the whole case: page, notebook cells, sticky note and buttons. Choose colours that fit the story's mood, as a designer would, and meet these contrast minimums (WCAG ratios, checked automatically):

| Pair | Minimum | Used for |
|---|---|---|
| `ink` on `bg` | 4.5 : 1 | main text |
| `ink` on `surface` | 4.5 : 1 | code in notebook cells |
| `note_ink` on `note` | 4.5 : 1 | sticky-note text |
| `muted` on `bg` | 3 : 1 | secondary text |
| `accent` on `bg` | 3 : 1 | buttons, the doodle's colour |

`surface` is close to `bg` (slightly lighter on a light theme, slightly lighter or darker on a dark one). `note` is a paper colour (pale yellow, pink, mint and so on) even on dark themes. `accent2` is a second highlight used for the story ribbon and error text. A dark `bg` is detected automatically.

### Doodle rules (`doodle_svg`)

A small hand-drawn line illustration of the story's world, shown on the archive card, the story intro and the win screen.

- The root must be exactly: `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 240 180' fill='none' stroke='currentColor' stroke-width='3' stroke-linecap='round' stroke-linejoin='round'>`
- Allowed elements: `g`, `path`, `circle`, `ellipse`, `rect`, `line`, `polyline`, `polygon`. **Nothing else**: no `text`, `style`, `image`, `use` or `script`, no `href`, `src`, `url(...)` or event attributes. Use **single quotes** for attributes.
- 15–40 elements, under 20,000 characters. Loose, slightly wobbly strokes read as hand-drawn. Use `opacity` or `stroke-dasharray` for texture and `fill='currentColor'` only for tiny details.
- Draw 2–3 objects from the story's world. One may carry a quiet visual clue, but it must not give the answer away.

### Before you reply, verify

- [ ] Your `id` starts with the level from the BRIEF and ends with random characters.
- [ ] The `meta.columns` keys equal the DataFrame's columns exactly, in the same order.
- [ ] `target_column` is one of those columns and appears **nowhere** in the title, hook or narrative.
- [ ] `check(df)` returns `True` on your data *after* a CSV round-trip, and would return `False` on a clean version.
- [ ] The difficulty matches the table. A `hard` fault is invisible in every single-column `describe()`.
- [ ] There are exactly 3 hints, vaguest first, and at least 3 accepted answers with no lone generic words.
- [ ] All the palette pairs meet their contrast minimums.
- [ ] The reply is one valid JSON object: strings escaped properly, no trailing commas, no comments.

## Format example (for structure only)

Do not reuse this setting or fault. It is deliberately tiny (the `narrative` is shortened) to show the shape.

```json
{
  "id": "easy_bakery_ovens_q8x",
  "level": "easy",
  "story": {
    "title": "The Oven That Never Cooled",
    "hook": "A bakery's oven log says everything is fine. The croissants disagree.",
    "narrative": [
      "Crumb & Co. runs four stone ovens through the night on Wyndham Street...",
      "Head baker Luis has thrown out three batches this week...",
      "He has exported the oven log for you. Somewhere in it, a number is lying..."
    ],
    "palette": {
      "bg": "#f6efe6", "surface": "#fffaf4", "ink": "#2e2118", "muted": "#7c6450",
      "accent": "#b5562a", "accent2": "#4f7a64", "note": "#ffeab0", "note_ink": "#2e2118"
    }
  },
  "meta": {
    "title": "Oven Temperature Log",
    "description": "Hourly readings from four ovens over two weeks. One thing in this log can't be trusted. Find it.",
    "columns": {
      "reading_id": "int, unique id",
      "oven": "categorical, A-D",
      "hour": "int, 0-23",
      "temp_c": "float, oven temperature in Celsius"
    }
  },
  "secret": {
    "fault_type": "sentinel_values",
    "target_column": "temp_c",
    "description": "When the thermometer disconnects, the logger writes -999 instead of leaving the cell empty. Eleven readings are -999. describe() on temp_c shows the impossible minimum at once.",
    "accepted_answers": ["temp_c", "temperature -999", "oven temperature sentinel"],
    "hints": [
      "Look at the minimum and maximum of every numeric column.",
      "The temperature column's minimum can't be physically right for a working oven.",
      "Eleven temp_c readings are exactly -999, a 'sensor disconnected' placeholder."
    ]
  },
  "data": {
    "seed": 4127,
    "code": [
      "def generate(rng):",
      "    n = 1344",
      "    df = pd.DataFrame({",
      "        'reading_id': np.arange(1, n + 1),",
      "        'oven': rng.choice(list('ABCD'), n),",
      "        'hour': np.tile(np.arange(24), n // 24),",
      "        'temp_c': rng.normal(215, 6, n).round(1),",
      "    })",
      "    # planted fault: disconnected-sensor placeholder values",
      "    bad = rng.choice(n, 11, replace=False)",
      "    df.loc[bad, 'temp_c'] = -999.0",
      "    return df",
      "",
      "def check(df):",
      "    return int((df['temp_c'] == -999).sum()) >= 5"
    ]
  },
  "doodle_svg": [
    "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 240 180' fill='none' stroke='currentColor' stroke-width='3' stroke-linecap='round' stroke-linejoin='round'>",
    "  <rect x='40' y='60' width='110' height='90' rx='8'/>",
    "  <path d='M58 60 q37 -40 74 0'/>",
    "  <circle cx='190' cy='70' r='24'/>",
    "  <path d='M190 70 L200 56'/>",
    "</svg>"
  ]
}
```

Now write the case for the BRIEF above. Reply with the JSON story pack only.

=== PROMPT END ===
