// Remember where a visitor first came from (UTM tags on the link they
// clicked, or else the referring site) for 30 days, on any page. The
// waitlist form sends it with a signup, so a click from LinkedIn still
// counts as LinkedIn even if they browse a few pages before joining.
(function () {
  var KEY = "mld.source";
  var DAYS = 30;
  try {
    var saved = JSON.parse(localStorage.getItem(KEY) || "null");
    if (saved && Date.now() - saved.at < DAYS * 86400000) return;   // keep the first touch
    var p = new URLSearchParams(location.search);
    var tag = ["utm_source", "utm_medium", "utm_campaign"].map(function (k) { return p.get(k); })
      .filter(Boolean).join(" / ");
    var ref = "";
    if (!tag && document.referrer) {
      var host = new URL(document.referrer).hostname;
      if (host !== location.hostname) ref = host;
    }
    var source = tag || ref;
    if (source) localStorage.setItem(KEY, JSON.stringify({ source: source.slice(0, 200), at: Date.now() }));
  } catch (e) { /* storage blocked: the form falls back to this page's own address */ }
})();
