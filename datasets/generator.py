"""
Dataset generator for the ML Detective game.

Each dataset is generated deterministically from a seed so it is
reproducible. For every dataset we write two files:

  datasets/<id>.csv           -> the data the player sees and loads as `df`
  ../secrets/<id>.json        -> PRIVATE. Never served to the browser.
                                  Contains the hidden fault description,
                                  accepted answers, and progressive hints.

A third, public file:
  datasets/<id>.meta.json     -> safe to send to the frontend. Business
                                  context, column names/dtypes, category tag.
                                  Does NOT contain the answer.

Run directly to (re)generate everything: `python generator.py`
"""
import json
import os

import numpy as np
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
SECRETS_DIR = os.path.join(HERE, "..", "secrets")
os.makedirs(SECRETS_DIR, exist_ok=True)


def _write(dataset_id, df, meta, secret):
    df.to_csv(os.path.join(HERE, f"{dataset_id}.csv"), index=False)
    with open(os.path.join(HERE, f"{dataset_id}.meta.json"), "w") as f:
        json.dump(meta, f, indent=2)
    with open(os.path.join(SECRETS_DIR, f"{dataset_id}.json"), "w") as f:
        json.dump(secret, f, indent=2)


# ---------------------------------------------------------------------------
# EASY: an outlier hiding in plain sight. Solvable with .describe() / a
# histogram / eyeballing min-max.
# ---------------------------------------------------------------------------
def make_easy():
    dataset_id = "easy_customer_orders"
    rng = np.random.default_rng(42)
    n = 600

    age = rng.normal(38, 11, n).round().astype(int)
    age = np.clip(age, 18, 75)

    # inject a handful of impossible ages: sensor/typo errors
    bad_idx = rng.choice(n, size=6, replace=False)
    age[bad_idx] = rng.choice([150, 151, 200, -5, 999, 130], size=6)

    order_value = rng.gamma(shape=2.5, scale=35, size=n).round(2)
    items_in_cart = rng.integers(1, 8, n)
    region = rng.choice(["North", "South", "East", "West"], n)
    is_returning_customer = rng.choice([0, 1], n, p=[0.4, 0.6])

    df = pd.DataFrame({
        "customer_id": np.arange(1001, 1001 + n),
        "age": age,
        "region": region,
        "items_in_cart": items_in_cart,
        "order_value": order_value,
        "is_returning_customer": is_returning_customer,
    })

    meta = {
        "id": dataset_id,
        "category": "easy",
        "title": "Customer Orders",
        "description": (
            "An e-commerce store exported one week of orders. Something in "
            "this export looks wrong -- find it."
        ),
        "n_rows": n,
        "columns": {
            "customer_id": "int, unique id",
            "age": "int, customer age in years",
            "region": "categorical, North/South/East/West",
            "items_in_cart": "int, 1-7",
            "order_value": "float, order total in USD",
            "is_returning_customer": "int, 0 or 1",
        },
    }

    secret = {
        "id": dataset_id,
        "category": "easy",
        "fault_type": "outlier_values",
        "target_column": "age",
        "description": (
            "A handful of rows have impossible ages (e.g. 150, -5, 999) -- "
            "data entry / sensor errors that a quick .describe() or "
            "histogram on 'age' reveals immediately."
        ),
        "accepted_answers": [
            "age", "the age column", "outlier in age", "age outliers",
            "invalid age", "impossible age values", "bad age values",
        ],
        "hints": [
            "Try df.describe() and look at each column's min and max -- "
            "one of them should not be physically possible.",
            "Focus on the 'age' column specifically. What's the maximum "
            "value? What's the minimum?",
            "Some rows have age = 150, 200, 999 or even -5. Those are the "
            "planted fault.",
        ],
    }
    _write(dataset_id, df, meta, secret)


# ---------------------------------------------------------------------------
# NORMAL: target leakage. A feature that is (almost) a direct function of
# the label. Needs a correlation check / groupby against the target to spot.
# ---------------------------------------------------------------------------
def make_normal():
    dataset_id = "normal_employee_salary"
    rng = np.random.default_rng(7)
    n = 800

    years_experience = rng.integers(0, 30, n)
    education = rng.choice(["Bachelors", "Masters", "PhD", "HighSchool"], n,
                            p=[0.45, 0.3, 0.1, 0.15])
    dept = rng.choice(["Engineering", "Sales", "HR", "Marketing"], n)
    performance_score = rng.integers(1, 6, n)  # 1-5

    edu_bonus = {"HighSchool": 0, "Bachelors": 8000, "Masters": 16000, "PhD": 26000}
    base = 35000 + years_experience * 1800 + performance_score * 1500
    base += np.array([edu_bonus[e] for e in education])
    noise = rng.normal(0, 3500, n)
    salary = (base + noise).round(2)

    # planted leakage: a "hr_flag" that is deterministically derived from
    # the target itself, rounded/bucketed to look like an innocent HR field.
    bonus_flag = (salary > np.median(salary)).astype(int)

    df = pd.DataFrame({
        "employee_id": np.arange(1, n + 1),
        "years_experience": years_experience,
        "education": education,
        "department": dept,
        "performance_score": performance_score,
        "bonus_eligible_flag": bonus_flag,
        "salary": salary,
    })
    df = df.sample(frac=1, random_state=1).reset_index(drop=True)

    meta = {
        "id": dataset_id,
        "category": "normal",
        "title": "Employee Salary",
        "description": (
            "HR wants to predict 'salary' from the other columns for a "
            "compensation model. One of the feature columns is suspicious "
            "-- it wouldn't actually be available before you know the "
            "answer. Find it."
        ),
        "n_rows": n,
        "columns": {
            "employee_id": "int, unique id",
            "years_experience": "int, 0-29",
            "education": "categorical",
            "department": "categorical",
            "performance_score": "int, 1-5",
            "bonus_eligible_flag": "int, 0 or 1, HR-set flag",
            "salary": "float, USD -- the prediction target",
        },
    }

    secret = {
        "id": dataset_id,
        "category": "normal",
        "fault_type": "target_leakage",
        "target_column": "bonus_eligible_flag",
        "description": (
            "bonus_eligible_flag is literally computed as "
            "(salary > median(salary)). It perfectly separates the target "
            "into two halves -- classic target leakage. A correlation "
            "check or groupby('bonus_eligible_flag')['salary'].describe() "
            "exposes it: the two groups don't overlap at all."
        ),
        "accepted_answers": [
            "bonus_eligible_flag", "bonus flag", "bonus_flag",
            "the bonus eligible flag column", "leakage in bonus flag",
        ],
        "hints": [
            "Look for a feature that correlates suspiciously strongly with "
            "the target 'salary'. Try df.corr(numeric_only=True).",
            "Group by each categorical/binary column and look at how "
            "'salary' is distributed within each group -- one column "
            "splits salary into two non-overlapping ranges.",
            "'bonus_eligible_flag' is derived directly from salary itself "
            "(it's just salary > median(salary)) -- that's target leakage.",
        ],
    }
    _write(dataset_id, df, meta, secret)


# ---------------------------------------------------------------------------
# HARD: a hidden near-duplicate cluster (a "fraud ring") that blends into
# the crowd on any single-column view and only shows up via duplicate /
# similarity / clustering analysis across multiple columns at once.
# ---------------------------------------------------------------------------
def make_hard():
    dataset_id = "hard_sensor_readings"
    rng = np.random.default_rng(99)
    n = 1500

    temperature = rng.normal(22, 4, n).round(2)
    humidity = rng.normal(50, 12, n).round(2)
    pressure = rng.normal(1013, 6, n).round(2)
    vibration = rng.exponential(0.8, n).round(3)
    device_id = rng.integers(100, 999, n)

    df = pd.DataFrame({
        "reading_id": np.arange(1, n + 1),
        "device_id": device_id,
        "temperature": temperature,
        "humidity": humidity,
        "pressure": pressure,
        "vibration": vibration,
    })

    # plant ~2% near-duplicate rows: a small cluster of readings that are
    # near-identical to each other across ALL sensor columns (tiny jitter),
    # simulating a malfunctioning device replaying a cached reading. They
    # don't stand out on any single column's histogram -- only pairwise
    # distance / duplicate-detection across columns reveals the cluster.
    cluster_size = 30
    template = {
        "temperature": 19.87,
        "humidity": 71.42,
        "pressure": 1005.11,
        "vibration": 0.021,
    }
    cluster_rows = []
    insert_positions = rng.choice(n, size=cluster_size, replace=False)
    for pos in insert_positions:
        jitter = rng.normal(0, 0.01, 4)
        df.loc[pos, "temperature"] = round(template["temperature"] + jitter[0], 3)
        df.loc[pos, "humidity"] = round(template["humidity"] + jitter[1], 3)
        df.loc[pos, "pressure"] = round(template["pressure"] + jitter[2], 3)
        df.loc[pos, "vibration"] = round(max(template["vibration"] + jitter[3], 0), 4)
        df.loc[pos, "device_id"] = 501  # same replaying device

    df = df.sample(frac=1, random_state=2).reset_index(drop=True)

    meta = {
        "id": dataset_id,
        "category": "hard",
        "title": "IoT Sensor Readings",
        "description": (
            "A fleet of IoT devices reports temperature/humidity/pressure/"
            "vibration. Nothing looks wrong column-by-column -- but a "
            "small group of rows shouldn't be there. Find what's off."
        ),
        "n_rows": n,
        "columns": {
            "reading_id": "int, unique id",
            "device_id": "int, sensor device id (100-998)",
            "temperature": "float, Celsius",
            "humidity": "float, percent",
            "pressure": "float, hPa",
            "vibration": "float, arbitrary units, non-negative",
        },
    }

    secret = {
        "id": dataset_id,
        "category": "hard",
        "fault_type": "hidden_duplicate_cluster",
        "target_column": "device_id",
        "description": (
            "~30 rows (about 2%) are near-duplicates of each other across "
            "ALL four sensor columns at once (tiny jitter only), all "
            "tagged device_id == 501 -- as if one malfunctioning device is "
            "replaying a cached reading. Invisible in any single column's "
            "distribution; shows up via duplicate-detection / clustering "
            "/ pairwise distance across the full feature set, or by "
            "noticing device_id 501 is wildly overrepresented relative to "
            "other device ids."
        ),
        "accepted_answers": [
            "device_id 501", "device 501", "duplicate cluster",
            "near duplicate rows", "duplicate readings", "device_id",
            "the device replaying readings", "repeated sensor readings",
        ],
        "hints": [
            "Column-by-column summary stats look clean. Try looking at "
            "combinations of columns together, or check df.duplicated() "
            "with a small rounding tolerance.",
            "Check df['device_id'].value_counts() -- is every device "
            "reporting a similar number of readings, or does one stick "
            "out?",
            "Device 501 appears far more often than any other device, and "
            "its rows are nearly identical to each other across "
            "temperature/humidity/pressure/vibration -- that's the "
            "planted anomaly.",
        ],
    }
    _write(dataset_id, df, meta, secret)


LEVELS = {
    "easy": ["easy_customer_orders"],
    "normal": ["normal_employee_salary"],
    "hard": ["hard_sensor_readings"],
}


if __name__ == "__main__":
    from stories import write_stories

    make_easy()
    make_normal()
    make_hard()
    write_stories()
    print("Generated datasets:")
    for cat, ids in LEVELS.items():
        print(f"  {cat}: {ids}")
