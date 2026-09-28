/* ML Detective landing page: small, dependency-free interactions.
   - scroll reveal (IntersectionObserver)
   - parallax layers ([data-speed]) and a drifting case wall
   - 3D tilt on case cards
   - briefcase "case closed" slam when it scrolls into view
   - SUSPECT. SOLVE. REPEAT. slam-in, then the candy REPEAT loop
   Reduced motion: no parallax, no tilt, final frames only. */
(() => {
  "use strict";

  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)");
  const finePointer = window.matchMedia("(hover: hover) and (pointer: fine)");
  const $ = (s, root = document) => root.querySelector(s);
  const $$ = (s, root = document) => Array.from(root.querySelectorAll(s));

  /* ---------------------------------------------------------------- nav */
  const toggle = $(".nav-toggle");
  const links = $("#nav-links");
  if (toggle && links) {
    const setOpen = (open) => {
      toggle.setAttribute("aria-expanded", String(open));
      links.classList.toggle("open", open);
    };
    toggle.addEventListener("click", () => setOpen(toggle.getAttribute("aria-expanded") !== "true"));
    links.addEventListener("click", (e) => { if (e.target.closest("a")) setOpen(false); });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") setOpen(false); });
  }

  /* ---------------------------------------------------------- reveal */
  const revealables = $$("[data-reveal], .case, .stamp");
  if ("IntersectionObserver" in window) {
    const io = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        const el = entry.target;
        // stagger siblings in the same row a little
        const idx = Number(el.dataset.stagger || 0);
        setTimeout(() => el.classList.add("in"), idx * 70);
        io.unobserve(el);
      });
    }, { rootMargin: "0px 0px -8% 0px", threshold: 0.12 });

    // give grouped items a stagger index
    [".steps .step", ".level-row .level-card", ".wall .case", ".mode-grid .mode", ".edu-list li", ".faq-list details"]
      .forEach((sel) => $$(sel).forEach((el, i) => { el.dataset.stagger = String(i % 5); }));
    revealables.forEach((el) => io.observe(el));
  } else {
    revealables.forEach((el) => el.classList.add("in"));
  }

  /* -------------------------------------------------------- parallax */
  const layers = $$("[data-speed]");
  const wall = $(".wall");
  const cases = $$(".wall .case");
  let caseCols = [];

  // work out which column each card sits in, so alternate columns drift
  const measureWall = () => {
    if (!wall) return;
    const lefts = [...new Set(cases.map((c) => c.offsetLeft))].sort((a, b) => a - b);
    caseCols = cases.map((c) => lefts.indexOf(c.offsetLeft));
  };

  let ticking = false;
  const update = () => {
    ticking = false;
    if (reduce.matches) return;
    const vh = window.innerHeight;
    layers.forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.bottom < -200 || r.top > vh + 200) return;
      const speed = parseFloat(el.dataset.speed) || 0;
      const center = r.top + r.height / 2 - vh / 2;
      el.style.translate = `0 ${(-center * speed).toFixed(1)}px`;
    });
    if (wall) {
      const r = wall.getBoundingClientRect();
      if (r.bottom > 0 && r.top < vh) {
        const progress = (r.top + r.height / 2 - vh / 2) / vh; // ~ -1..1
        const amp = window.innerWidth < 600 ? 14 : 36;
        cases.forEach((c, i) => {
          const dir = caseCols[i] % 2 === 0 ? 1 : -1;
          c.style.setProperty("--px", `${(progress * amp * dir).toFixed(1)}px`);
        });
      }
    }
  };
  const onScroll = () => {
    if (!ticking) { ticking = true; requestAnimationFrame(update); }
  };
  const clearParallax = () => {
    layers.forEach((el) => { el.style.translate = ""; });
    cases.forEach((c) => c.style.removeProperty("--px"));
  };

  measureWall();
  window.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("resize", () => { measureWall(); onScroll(); });
  reduce.addEventListener?.("change", () => { if (reduce.matches) clearParallax(); else onScroll(); });
  onScroll();

  /* ------------------------------------------------------- 3D tilt */
  cases.forEach((card) => {
    const inner = $(".case-in", card);
    if (!inner) return;
    card.addEventListener("pointermove", (e) => {
      if (reduce.matches || !finePointer.matches) return;
      const r = card.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width - 0.5;
      const y = (e.clientY - r.top) / r.height - 0.5;
      card.classList.add("tilting");
      inner.style.setProperty("--ry", `${(x * 18).toFixed(2)}deg`);
      inner.style.setProperty("--rx", `${(-y * 18).toFixed(2)}deg`);
    });
    card.addEventListener("pointerleave", () => {
      card.classList.remove("tilting");
      inner.style.setProperty("--rx", "0deg");
      inner.style.setProperty("--ry", "0deg");
    });
  });

  /* ------------------------------------------ briefcase slam divider */
  const closed = $("#closed");
  const replay = $("#replay");
  if (closed) {
    const play = () => {
      if (reduce.matches) { closed.classList.add("done"); return; }
      closed.classList.remove("play", "done");
      void closed.offsetWidth; // restart the animations
      closed.classList.add("play");
    };
    if (reduce.matches || !("IntersectionObserver" in window)) {
      closed.classList.add("done");
    } else {
      const cio = new IntersectionObserver((entries) => {
        if (entries.some((e) => e.isIntersecting)) { play(); cio.disconnect(); }
      }, { threshold: 0.55 });
      cio.observe(closed);
    }
    replay?.addEventListener("click", play);
  }

  /* ------------------------------------------- stakeout toast cycle */
  const toast = $(".m-stakeout .toast");
  const toastMsg = toast && $(".toast-msg", toast);
  if (toast && toastMsg) {
    const msgs = [
      'OutlierQueen just closed "The Model That Knew Too Much" in 1m 49s',
      'Sherlock_27 just closed "Echoes in the Static" in 3m 14s',
      'PandasPro just closed "The Tuesday Ledger" in 2m 29s',
    ];
    let n = 0;
    let timer = null;
    const cycle = () => {
      toast.classList.remove("show");
      setTimeout(() => {
        toastMsg.textContent = msgs[n % msgs.length];
        n += 1;
        toast.classList.add("show");
      }, 450);
    };
    if (reduce.matches || !("IntersectionObserver" in window)) {
      toast.classList.add("show");
    } else {
      new IntersectionObserver((entries) => {
        const visible = entries[0].isIntersecting;
        if (visible && !timer) { cycle(); timer = setInterval(cycle, 4200); }
        if (!visible && timer) { clearInterval(timer); timer = null; }
      }, { threshold: 0.4 }).observe(toast.closest(".mode"));
    }
  }

  /* ------------------------------------ SUSPECT. SOLVE. REPEAT. */
  const end = $(".end");
  const repeat = $("#repeat");
  if (end && repeat) {
    const land = () => {
      end.classList.add("in");
      if (reduce.matches) { repeat.classList.add("live"); return; }
      setTimeout(() => repeat.classList.add("live"), 1900);
    };
    if ("IntersectionObserver" in window && !reduce.matches) {
      const eio = new IntersectionObserver((entries) => {
        if (entries.some((e) => e.isIntersecting)) { land(); eio.disconnect(); }
      }, { threshold: 0.35 });
      eio.observe(end);
    } else {
      land();
    }
  }
})();
