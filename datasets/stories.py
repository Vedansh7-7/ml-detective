"""
Storylines -- the narrative layer drafted alongside each dataset.

Each story is PUBLIC (safe to send to the browser): it sets the scene,
the colour palette and the doodle, but must never state the answer.
The answer only lives in secrets/<id>.json.

Written to datasets/<id>.story.json by write_stories(), which
generator.py calls after writing the data. Run this file on its own to
refresh just the stories without touching the data.

Palette keys (all used by the story IDE's CSS variables):
  bg        page background
  surface   cells / panels
  ink       main text
  muted     secondary text, borders
  accent    primary action colour
  accent2   secondary highlight
  note      sticky-note paper
  note_ink  sticky-note text
  dark      true if bg is dark (flips form-control colour scheme)
"""
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))

STORIES = {
    "easy_customer_orders": {
        "level": "easy",
        "title": "The Tuesday Ledger",
        "hook": "A yarn shop's weekly orders. The accountant says one thing in here can't be real.",
        "narrative": [
            "Marigold & Thread is a two-room shop in a converted bakery that "
            "sells hand-dyed yarn online. Every Sunday night Priya exports the "
            "week's orders and emails them to her accountant, Mr. Okafor.",
            "This week he replied with a single line: \"Something in here "
            "can't be real.\" Then he left for a fishing trip with no signal.",
            "Priya has 600 orders, a tax filing due Monday, and no idea what he "
            "meant. She has asked you to go through the ledger before then. "
            "Start where any bookkeeper would: the totals, the ranges, the "
            "extremes.",
        ],
        "palette": {
            "bg": "#f7ecdc", "surface": "#fffaf2", "ink": "#3b2418",
            "muted": "#8a6a55", "accent": "#d4622a", "accent2": "#6f8f4e",
            "note": "#ffe7a3", "note_ink": "#3b2418", "dark": False,
        },
        "doodle": "easy_customer_orders.svg",
    },
    "normal_employee_salary": {
        "level": "normal",
        "title": "The Model That Knew Too Much",
        "hook": "A salary model scored perfectly on its first try. The CFO doesn't trust perfect.",
        "narrative": [
            "Halvorsen Freight hired a consultant to build a model that "
            "predicts what each of its 800 employees should earn. On the "
            "first run it was flawless. Every prediction landed on the right "
            "side of the line.",
            "The consultant sent a celebratory email. CFO Ingrid Halvorsen "
            "did not reply to it. She has sat through enough board meetings "
            "to know that a perfect model usually means someone let it see "
            "the answers.",
            "She has handed you the training table. Somewhere in these "
            "columns is a source that knows more than it should. Find it "
            "before the model goes live.",
        ],
        "palette": {
            "bg": "#eaeef4", "surface": "#ffffff", "ink": "#18263a",
            "muted": "#5d6b80", "accent": "#2f5fd0", "accent2": "#d9a521",
            "note": "#fff1b8", "note_ink": "#18263a", "dark": False,
        },
        "doodle": "normal_employee_salary.svg",
    },
    "hard_sensor_readings": {
        "level": "hard",
        "title": "Echoes in the Static",
        "hook": "An unmanned weather rig in the North Sea. Every chart looks clean. The night engineer says it sounds wrong.",
        "narrative": [
            "Station Kestrel is an unmanned weather outpost bolted to a "
            "decommissioned rig 90 km off the Scottish coast. A mesh of "
            "small devices reports temperature, humidity, pressure and "
            "vibration back to shore.",
            "Every dashboard is green. Every histogram is textbook. The data "
            "team has signed it off twice.",
            "Only Tomasz, the night-shift engineer, disagrees. He says the "
            "station sounds wrong after midnight, \"like a record that has "
            "started to skip.\" Nobody believes him. Pull the 1,500 readings "
            "and prove him right.",
        ],
        "palette": {
            "bg": "#0d1a1b", "surface": "#132628", "ink": "#d6ebe8",
            "muted": "#7fa5a1", "accent": "#35e0c2", "accent2": "#ff5f5f",
            "note": "#e9f5c9", "note_ink": "#14201f", "dark": True,
        },
        "doodle": "hard_sensor_readings.svg",
    },
}


def write_stories():
    for dataset_id, story in STORIES.items():
        out = {"id": dataset_id, **story}
        with open(os.path.join(HERE, f"{dataset_id}.story.json"), "w") as f:
            json.dump(out, f, indent=2)


if __name__ == "__main__":
    write_stories()
    print(f"Wrote {len(STORIES)} stories.")
