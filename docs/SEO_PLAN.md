# SEO plan

**Goal:** students and job-seekers who search for practice ("pandas practice problems", "data cleaning exercises", "target leakage example") find ML Detective and play a case.

**Decisions (Sept 2026):** stay on `ml-detective.vercel.app` for now (a custom domain later is a one-line change in `tools/build_learn.py`); target students and job-seekers first; case pages name the *skill* a case trains, never the column or the answer.

## How search works, briefly

1. **Crawl:** Google follows links and the sitemap.
2. **Index:** it reads each page's title, headings and text. Content that only appears after JavaScript runs (the game) is weak material, so every case also has a plain HTML page.
3. **Rank:** relevance to the query, trust (links from other sites, a domain of our own), and experience (speed, mobile, HTTPS).

## Phase 1: foundations (done)

- `sitemap.xml` and `robots.txt`, regenerated on every build
- Canonical URLs, absolute Open Graph tags and a 1200×630 preview image
- Structured data: WebSite, VideoGame and FAQPage on the landing page; LearningResource on each case page; ItemList on the hub
- Landing title and description written for "data cleaning and pandas practice"
- Vercel Web Analytics script in place

**To do by hand:**
- Turn on Web Analytics in the Vercel project.
- Verify the site in Google Search Console and submit `sitemap.xml`. Do the same in Bing Webmaster Tools.

## Phase 2: content engine (done, and keeps growing)

- `/learn/` hub and one page per case, generated from the story packs plus `tools/case_skills.json`.
- **Each case page** has:
  - the story
  - what you'll practise
  - the dataset's columns
  - related cases
  - a button straight into the case
- **New core cases:** add an entry to `case_skills.json` and they get a page on the next build.
- **Next:** pages for past weekly cases once their week is over. That means a build step that reads them from Supabase.

## Phase 3: authority (ongoing, from launch week)

- **Communities (genuine show-and-tell, not spam):**
  - Kaggle discussions, r/datascience, r/learnpython
  - LinkedIn: each weekly case and its winner
- **Your own network:** IIT Indore student clubs and department pages, plus educators from the waitlist.
- **Resource lists:** "awesome" data-science learning lists on GitHub, and a Product Hunt launch once a custom domain is in place.
- **Tag every link we post with `utm_source`.** The waitlist stores it, so we can see which channel brings educators.

## Measuring it

- **Search Console:** impressions and clicks per `/learn/` page, and which searches find us.
- **Vercel Analytics:** visits, top pages, referrers.
- **The admin board (`/admin/`):** new players, solves and the waitlist by source.

Expect organic search to take 2–6 months to show results. Launch posts and communities bring the first players.
