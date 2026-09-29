"""
Static, indexable pages for search engines: a /learn/ hub, one page per
case, sitemap.xml and robots.txt. Called by tools/build_web.py.

The game itself is a JavaScript app that search engines read poorly, so
each case also gets a plain HTML page: the story, the skill it trains
(from tools/case_skills.json: name the skill, never the answer), the
dataset's public columns, and a button straight into that case.
"""
import datetime
import html
import json
import os
import re

# Change this one line when the site moves to its own domain.
SITE_URL = "https://ml-detective.vercel.app"

LEVEL_NAME = {"easy": "Easy", "normal": "Normal", "hard": "Hard"}
LEVEL_BLURB = {
    "easy": "The fault lives in one column. Summary statistics, value counts and a histogram will get you there.",
    "normal": "The fault is a relationship: a feature against the target, against time, or against another source.",
    "hard": "Every single-column summary looks fine. The fault only shows across columns, inside groups, or over time.",
}
esc = html.escape


def slugify(title):
    return re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")


def page(title, description, path, body, head_extra="", depth=1):
    up = "../" * depth
    canonical = f"{SITE_URL}{path}"
    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{esc(title)}</title>
<meta name="description" content="{esc(description)}">
<link rel="canonical" href="{canonical}">
<meta name="theme-color" content="#0a0a0a">
<meta property="og:type" content="website">
<meta property="og:site_name" content="ML Detective">
<meta property="og:title" content="{esc(title)}">
<meta property="og:description" content="{esc(description)}">
<meta property="og:url" content="{canonical}">
<meta property="og:image" content="{SITE_URL}/assets/og.png">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" href="/favicon.ico" sizes="32x32">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="manifest" href="/site.webmanifest">
<link rel="stylesheet" href="{up}site.css">
<link rel="stylesheet" href="{up}learn/learn.css">
{head_extra}
<script defer src="/_vercel/insights/script.js"></script>
<script src="/utm.js"></script>
</head>
<body class="learn">
<header class="lr-bar">
  <a class="brand" href="/" aria-label="ML Detective home"><span class="brand-ml">ML</span><span class="brand-det">DETECTIVE</span></a>
  <nav class="lr-nav" aria-label="Main">
    <a href="/learn/">All cases</a>
    <a class="btn btn-tape btn-sm" href="/play/">Play</a>
  </nav>
</header>
<main class="lr-main">
{body}
</main>
<footer class="lr-foot">
  <a href="/">ML Detective</a> · <a href="/learn/">All cases</a> · <a href="/play/">Play in your browser</a> · <a href="mailto:vedansh.shrivastavaa@gmail.com">Contact</a> · <a href="/privacy/">Privacy</a> · <a href="/terms/">Terms</a>
  <br>© 2026 Vedansh Shrivastava · Free for non-commercial use · <a href="https://github.com/Vedansh7-7/ml-detective/blob/main/COMMERCIAL.md" rel="noopener">Licence</a>
</footer>
</body>
</html>
"""


def ld(obj):
    return f'<script type="application/ld+json">{json.dumps(obj, ensure_ascii=False)}</script>'


def case_card(c):
    return f"""<li class="lr-card">
  <a href="/learn/{c['slug']}/">
    <span class="lr-level lr-{c['level']}">{LEVEL_NAME[c['level']]}</span>
    <b>{esc(c['title'])}</b>
    <span class="lr-skill">{esc(c['skill'])}</span>
    <span class="lr-hook">{esc(c['hook'])}</span>
  </a>
</li>"""


def build(web_dir, levels, doodles_dir):
    here = os.path.dirname(os.path.abspath(__file__))
    with open(os.path.join(here, "case_skills.json"), encoding="utf-8") as f:
        skills = json.load(f)

    cases = []
    for level, items in levels.items():
        for item in items:
            s, m = item["story"], item["meta"]
            extra = skills.get(s["id"]) or {"skill": "Find the planted fault", "practise": ["exploratory data analysis"]}
            with open(os.path.join(doodles_dir, s["doodle"]), encoding="utf-8") as f:
                svg = f.read()
            cases.append({"id": s["id"], "slug": slugify(s["title"]), "level": level, "title": s["title"],
                          "hook": s["hook"], "narrative": s["narrative"], "palette": s["palette"],
                          "meta": m, "svg": svg, **extra})

    learn = os.path.join(web_dir, "learn")
    for name in os.listdir(learn) if os.path.isdir(learn) else []:
        p = os.path.join(learn, name, "index.html")
        if os.path.isfile(p):
            os.remove(p)
            os.rmdir(os.path.join(learn, name))
    os.makedirs(learn, exist_ok=True)

    for c in cases:
        related = [o for o in cases if o["id"] != c["id"] and o["level"] == c["level"]][:3]
        related += [o for o in cases if o["level"] != c["level"]][: 4 - len(related)]
        cols = "".join(f"<tr><td><code>{esc(k)}</code></td><td>{esc(v)}</td></tr>"
                       for k, v in c["meta"]["columns"].items())
        pal = c["palette"]
        body = f"""<nav class="lr-crumbs" aria-label="Breadcrumb"><a href="/learn/">Learn</a> › <span>{LEVEL_NAME[c['level']]} case</span></nav>
<article class="lr-case" style="--c-bg:{pal['bg']};--c-ink:{pal['ink']};--c-accent:{pal['accent']}">
  <div class="lr-hero">
    <div>
      <p class="lr-kicker">{LEVEL_NAME[c['level']]} case · data forensics in Python</p>
      <h1>{esc(c['title'])}</h1>
      <p class="lr-lead">{esc(c['skill'])}.</p>
      <p class="lr-hookline">{esc(c['hook'])}</p>
      <a class="btn btn-tape btn-lg" href="/play/#case/{c['id']}">Play this case <span aria-hidden="true">→</span></a>
    </div>
    <div class="lr-doodle" aria-hidden="true">{c['svg']}</div>
  </div>
  <section><h2>The story</h2>{''.join(f'<p>{esc(p)}</p>' for p in c['narrative'])}</section>
  <section><h2>What you'll practise</h2><ul>{''.join(f'<li>{esc(p)}</li>' for p in c['practise'])}</ul>
    <p>{esc(LEVEL_BLURB[c['level']])} You write real pandas, NumPy and scikit-learn code in a notebook that runs in your browser. Nothing to install.</p></section>
  <section><h2>The data</h2><p>{esc(c['meta']['description'])} {c['meta'].get('n_rows', '')} rows, loaded as <code>df</code>.</p>
    <table class="lr-cols"><thead><tr><th>Column</th><th>What it holds</th></tr></thead><tbody>{cols}</tbody></table></section>
  <p class="lr-cta"><a class="btn btn-ink" href="/play/#case/{c['id']}">Open the case <span aria-hidden="true">→</span></a></p>
</article>
<section class="lr-related"><h2>More cases</h2><ul class="lr-grid">{''.join(case_card(o) for o in related)}</ul></section>"""
        schema = ld({
            "@context": "https://schema.org", "@type": "LearningResource",
            "name": c["title"], "description": f"{c['skill']}. {c['hook']}",
            "url": f"{SITE_URL}/learn/{c['slug']}/", "teaches": c["skill"],
            "learningResourceType": "Interactive exercise", "educationalLevel": LEVEL_NAME[c["level"]],
            "isAccessibleForFree": True, "inLanguage": "en",
            "keywords": ", ".join(["data cleaning", "pandas practice", "python", *c["practise"]]),
            "provider": {"@type": "Organization", "name": "ML Detective", "url": SITE_URL},
        })
        desc = f"{c['skill']}. {c['hook']}"
        if len(desc) > 158:
            desc = desc[:155].rsplit(" ", 1)[0] + "…"
        out = os.path.join(learn, c["slug"])
        os.makedirs(out, exist_ok=True)
        with open(os.path.join(out, "index.html"), "w", encoding="utf-8") as f:
            f.write(page(f"{c['title']}: {c['skill']} · ML Detective", desc, f"/learn/{c['slug']}/",
                         body, schema, depth=2))

    groups = "".join(
        f"""<section class="lr-group"><h2>{LEVEL_NAME[lvl]} <span>{sum(1 for c in cases if c['level'] == lvl)} cases</span></h2>
<p>{esc(LEVEL_BLURB[lvl])}</p><ul class="lr-grid">{''.join(case_card(c) for c in cases if c['level'] == lvl)}</ul></section>"""
        for lvl in ("easy", "normal", "hard"))
    hub = f"""<section class="lr-intro">
  <p class="lr-kicker">Learn · {len(cases)} cases</p>
  <h1>Data cleaning and pandas practice, one case at a time</h1>
  <p class="lr-lead">Every case is a real-looking dataset with exactly one planted problem: an impossible value, a leaky feature, a unit mix-up, a pattern hiding across columns. Find it with your own Python, right in the browser.</p>
  <p>Several are modelled on real data disasters, from spreadsheet software renaming genes to a spacecraft lost to mixed units. Start with Easy if you're new to pandas; Hard cases need grouping, statistics and a little signal processing.</p>
  <a class="btn btn-tape btn-lg" href="/play/">Play in your browser <span aria-hidden="true">→</span></a>
</section>
{groups}"""
    hub_schema = ld({
        "@context": "https://schema.org", "@type": "ItemList", "name": "ML Detective cases",
        "itemListElement": [{"@type": "ListItem", "position": i + 1, "url": f"{SITE_URL}/learn/{c['slug']}/",
                             "name": c["title"]} for i, c in enumerate(cases)],
    })
    with open(os.path.join(learn, "index.html"), "w", encoding="utf-8") as f:
        f.write(page("Data cleaning and pandas practice cases · ML Detective",
                     f"{len(cases)} hands-on data forensics cases: find the one planted fault with pandas and Python, "
                     "in your browser. Practise data cleaning, leakage, units, Simpson's paradox and more.",
                     "/learn/", hub, hub_schema))

    today = datetime.date.today().isoformat()
    urls = ["/", "/play/", "/learn/", "/privacy/", "/terms/"] + [f"/learn/{c['slug']}/" for c in cases]
    with open(os.path.join(web_dir, "sitemap.xml"), "w", encoding="utf-8") as f:
        f.write('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n')
        for u in urls:
            f.write(f"  <url><loc>{SITE_URL}{u}</loc><lastmod>{today}</lastmod></url>\n")
        f.write("</urlset>\n")
    with open(os.path.join(web_dir, "robots.txt"), "w", encoding="utf-8") as f:
        f.write(f"User-agent: *\nAllow: /\n\nSitemap: {SITE_URL}/sitemap.xml\n")
    return len(cases)
