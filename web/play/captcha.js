// Cloudflare Turnstile tokens for Supabase sign-ins (guest, admin).
// The widget stays invisible unless Cloudflare decides it needs the player
// to click; then it appears at the bottom of the screen. Each token is
// single-use, so every sign-in asks for a fresh one.
import { TURNSTILE_SITE_KEY } from "./config.js";

const SCRIPT = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
let scriptPromise = null;
let host = null;
let widgetId = null;

function loadTurnstile() {
  scriptPromise ??= new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = SCRIPT;
    s.async = true;
    s.onload = () => resolve(window.turnstile);
    s.onerror = () => { scriptPromise = null; reject(new Error("the bot check couldn't load")); };
    document.head.appendChild(s);
  });
  return scriptPromise;
}

// -> a token, or undefined when Turnstile is switched off
export async function captchaToken(timeoutMs = 25_000) {
  if (!TURNSTILE_SITE_KEY) return undefined;
  const turnstile = await loadTurnstile();
  if (!host) {
    host = document.createElement("div");
    host.className = "captcha-host";
    document.body.appendChild(host);
  }
  if (widgetId !== null) {
    try { turnstile.remove(widgetId); } catch { /* already gone */ }
    widgetId = null;
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("the bot check timed out")), timeoutMs);
    widgetId = turnstile.render(host, {
      sitekey: TURNSTILE_SITE_KEY,
      appearance: "interaction-only",
      callback: (token) => { clearTimeout(timer); resolve(token); },
      "error-callback": () => { clearTimeout(timer); reject(new Error("the bot check failed")); },
    });
  });
}
