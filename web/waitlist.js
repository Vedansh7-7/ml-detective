// Waitlist form on the landing page. The backend client (and the invisible
// Cloudflare bot check it runs before signing in) only loads when someone
// actually submits, so the landing page stays light.
const form = document.getElementById("waitlist");
const status = form.querySelector(".wl-status");
const button = form.querySelector("button[type=submit]");

function say(text, kind = "") {
  status.textContent = text;
  status.dataset.kind = kind;
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!form.reportValidity()) return;
  const f = new FormData(form);
  if (f.get("website")) { say("Thanks, you're on the list.", "ok"); form.reset(); return; }   // bot

  button.disabled = true;
  say("Adding you…");
  // first place this visitor came from (utm.js keeps it for 30 days), else this visit's
  let remembered = null;
  try { remembered = JSON.parse(localStorage.getItem("mld.source") || "null"); } catch { /* blocked */ }
  const params = new URLSearchParams(location.search);
  const source = (remembered && remembered.source)
    || ["utm_source", "utm_medium", "utm_campaign"].map((k) => params.get(k)).filter(Boolean).join(" / ")
    || (document.referrer ? new URL(document.referrer).hostname : "direct");
  try {
    const { connect, sb } = await import("./play/online.js");
    say("Running a quick bot check… if a box appears at the bottom of the screen, tick it.");
    // first visits can take a while (or need a click); give it time, and one retry
    await connect({ captchaWaitMs: 45_000 }).catch(() => connect({ captchaWaitMs: 45_000 }));
    say("Adding you…");
    const { error } = await sb.from("waitlist").insert({
      name: String(f.get("name")).trim(),
      email: String(f.get("email")).trim(),
      role: f.get("role"),
      organization: String(f.get("organization") || "").trim() || null,
      use_case: String(f.get("use_case") || "").trim() || null,
      consent: f.get("consent") === "on",
      source: source.slice(0, 200),
    });
    if (error && error.code !== "23505") throw error;
    say(error ? "You're already on the list. We'll be in touch." : "Thanks, you're on the list. We'll be in touch.", "ok");
    form.reset();
  } catch (err) {
    console.warn("waitlist:", err);
    say("That didn't go through. Please try again in a moment.", "bad");
  } finally {
    button.disabled = false;
  }
});
