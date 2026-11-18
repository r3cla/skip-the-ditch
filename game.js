(() => {
  "use strict";

  // ---------- Tuning ----------
  const GOAL_KM = 2150;        // roughly Sydney → Auckland
  const QUESTION_TIME = 12;    // seconds per question
  const MAX_SPIN = 3;          // lives
  const STREAK_FOR_SPIN = 5;   // correct-in-a-row needed to regain a spin
  const ROCK_SCREEN_X = 0.3;   // rock sits at 30% of screen width

  // ---------- DOM ----------
  const $ = (id) => document.getElementById(id);
  const app = $("app");
  const canvas = $("scene");
  const ctx = canvas.getContext("2d");
  const card = $("card");
  const overlay = $("overlay");
  const tagEl = $("tag"), qnumEl = $("qnum"), questionEl = $("question");
  const answersEl = $("answers"), factEl = $("fact"), timerFill = $("timer-fill");
  const distEl = $("dist"), spinEl = $("spin"), streakEl = $("streak");
  const progFill = $("progress-fill"), progRock = $("progress-rock");
  const muteBtn = $("mute");
  const reportEl = $("report");

  const TAGS = { au: "Australia", nz: "Aotearoa NZ", tt: "Trans-Tasman" };
  const MODES = {
    au:   { label: "Australia",   sub: "Aussie questions only",       cats: ["au"],             share: "Aussie" },
    nz:   { label: "Aotearoa NZ", sub: "Kiwi questions only",         cats: ["nz"],             share: "Kiwi" },
    both: { label: "Both",        sub: 'Aussie, Kiwi &amp; <span class="nowrap">trans-Tasman</span>', cats: ["au", "nz", "tt"], share: "trans-Tasman" },
  };
  const MODE_KEYS = Object.keys(MODES);

  // Submissions go to GitHub issue forms (.github/ISSUE_TEMPLATE). Point this elsewhere
  // (e.g. a Google Form) if players shouldn't need a GitHub account.
  const ISSUES_URL = "https://github.com/r3cla/skip-the-ditch/issues/new";
  const issueLink = (template, fields = {}) =>
    `${ISSUES_URL}?${new URLSearchParams({ template, ...fields })}`;
  const contributeLinks = `
    <p class="contribute">
      <a href="${issueLink("suggest-question.yml")}" target="_blank" rel="noopener">Suggest a question</a>
      <span aria-hidden="true">·</span>
      <a href="${issueLink("feedback.yml")}" target="_blank" rel="noopener">Send feedback</a>
    </p>`;

  // ---------- Storage (safe) ----------
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } },
  };

  // ---------- Sound (tiny synth, no files) ----------
  let audio = null;
  let muted = store.get("std-muted", false);
  function getAudio() {
    if (!audio) {
      try { audio = new (window.AudioContext || window.webkitAudioContext)(); } catch { audio = null; }
    }
    if (audio && audio.state === "suspended") audio.resume();
    return audio;
  }
  function tone({ f0, f1 = f0, dur = 0.15, type = "sine", vol = 0.2, delay = 0 }) {
    if (muted) return;
    const a = getAudio();
    if (!a) return;
    const t = a.currentTime + delay;
    const o = a.createOscillator(), g = a.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(f1, t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(a.destination);
    o.start(t);
    o.stop(t + dur + 0.02);
  }
  const sfx = {
    skip: () => tone({ f0: 1400, f1: 380, dur: 0.11, vol: 0.12 }),
    right: () => { tone({ f0: 660, dur: 0.12, type: "triangle", vol: 0.14 }); tone({ f0: 990, dur: 0.2, type: "triangle", vol: 0.14, delay: 0.1 }); },
    wrong: () => tone({ f0: 220, f1: 130, dur: 0.32, type: "square", vol: 0.05 }),
    sink: () => tone({ f0: 520, f1: 55, dur: 0.8, vol: 0.2 }),
    win: () => [523, 659, 784, 1047].forEach((f, i) => tone({ f0: f, dur: 0.28, type: "triangle", vol: 0.14, delay: i * 0.13 })),
  };
  function renderMute() {
    muteBtn.textContent = muted ? "🔇" : "🔊";
    muteBtn.setAttribute("aria-pressed", String(muted));
  }
  muteBtn.addEventListener("click", () => { muted = !muted; store.set("std-muted", muted); renderMute(); });
  renderMute();

  // ---------- Canvas sizing ----------
  let W = 0, H = 0, waterY = 0;
  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = canvas.clientWidth;
    H = canvas.clientHeight;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (!waterY) waterY = H * 0.55;
  }
  window.addEventListener("resize", resize);
  resize();

  const unit = () => Math.max(0.75, Math.min(1.4, H / 700));
  const ppk = () => Math.max(W, 360) / 420; // pixels per km
  let camKm = 0;
  const sx = (km) => W * ROCK_SCREEN_X + (km - camKm) * ppk();

  // ---------- Game state ----------
  let state = "title"; // title | flying | waiting | question | feedback | sinking | winning | over | won
  let run = 0;         // increments each game so stale timeouts are ignored
  let rock = { km: 0, y: 0, rot: 0, tilt: 0, sink: 0 };
  let flight = null, segments = [], wobbleNext = false;
  let ripples = [], drops = [], bubbles = [];
  let spin = MAX_SPIN, streak = 0, right = 0, asked = 0;
  let current = null, qStart = 0, hoverRipple = 0;
  let mode = store.get("std-mode", "both");
  if (!MODES[mode]) mode = "both";
  // Best distance per mode. Older saves had a single best from the mixed question set.
  const bests = Object.assign({ both: store.get("std-best", 0) }, store.get("std-bests", {}));
  let deck = [];
  let time = 0;

  const shuffle = (arr) => {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  };
  function drawQuestion() {
    if (!deck.length) {
      const cats = MODES[mode].cats;
      deck = shuffle(QUESTIONS.filter((q) => cats.includes(q.c)));
    }
    return deck.pop();
  }
  function setMode(k) {
    if (!MODES[k]) return;
    if (k !== mode) deck = [];
    mode = k;
    store.set("std-mode", mode);
    for (const b of overlay.querySelectorAll(".mode")) b.setAttribute("aria-pressed", String(b.dataset.mode === mode));
    const bestEl = $("best-line");
    if (bestEl) {
      const b = bests[mode] || 0;
      bestEl.innerHTML = b ? `Your best (${MODES[mode].label}): <b>${fmt(b)} km</b>` : "";
      bestEl.hidden = !b;
    }
  }
  const fmt = (n) => Math.round(n).toLocaleString("en-AU");
  const show = (el) => el.classList.remove("hidden");
  const hide = (el) => el.classList.add("hidden");
  const srEl = $("sr");
  function announce(text) {
    // Clear first so the same message twice in a row is still read out
    srEl.textContent = "";
    setTimeout(() => { srEl.textContent = text; }, 30);
  }
  // Panels fade in from visibility:hidden, which can't take focus on the first frame,
  // so wait a beat before moving focus.
  const focusEl = (el) => {
    if (el) setTimeout(() => { if (el.isConnected) el.focus({ preventScroll: true }); }, 60);
  };

  // ---------- HUD ----------
  let lastDist = -1;
  function updateHud() {
    spinEl.innerHTML = "";
    for (let i = 0; i < MAX_SPIN; i++) {
      const p = document.createElement("span");
      p.className = "pip" + (i < spin ? "" : " off");
      spinEl.appendChild(p);
    }
    spinEl.setAttribute("role", "img");
    spinEl.setAttribute("aria-label", `${spin} of ${MAX_SPIN} spins left`);
    streakEl.textContent = streak;
  }
  function updateDistance() {
    const d = Math.round(rock.km);
    if (d === lastDist) return;
    lastDist = d;
    distEl.textContent = `${fmt(d)} km`;
    const pct = Math.min(100, (rock.km / GOAL_KM) * 100);
    progFill.style.width = pct + "%";
    progRock.style.left = pct + "%";
  }

  function toast(text, kind) {
    const t = document.createElement("div");
    t.className = "toast " + (kind || "");
    t.textContent = text;
    t.style.left = sx(rock.km) + "px";
    t.style.top = Math.max(90, waterY - 110 * unit()) + "px";
    app.appendChild(t);
    setTimeout(() => t.remove(), 1600);
  }

  // ---------- Screens ----------
  // Menus hide the in-game stats (they'd only repeat what the panel says) so the panel has room.
  function showMenu() {
    app.classList.add("menu");
    show(overlay);
  }

  // `fromUser` is true when reached by clicking (e.g. "Change"); on first page load we
  // leave focus alone so no focus ring appears before the player has done anything.
  function titleScreen(fromUser) {
    state = "title";
    rock = { km: 0, y: -30 * unit(), rot: 0, tilt: 0, sink: 0 };
    camKm = 0;
    ripples = []; drops = []; bubbles = [];
    lastDist = -1;
    overlay.innerHTML = `
      <div class="panel split">
        <div class="col">
          <p class="kicker">Trans-Tasman trivia</p>
          <h1>Skip the Ditch</h1>
          <p class="lede">Skim a rock ${fmt(GOAL_KM)} km from Bondi Beach to Auckland. Every right answer is another bounce. Answer faster to fly further.</p>
          <ul class="rules">
            <li><span aria-hidden="true">⚡</span> <b>Quick answers</b> mean longer skips</li>
            <li><span aria-hidden="true">❌</span> <b>Wrong or too slow</b> costs 1 spin</li>
            <li><span aria-hidden="true">🪨</span> <b>Lose all ${MAX_SPIN} spins</b> and your rock sinks</li>
            <li><span aria-hidden="true">🔥</span> <b>${STREAK_FOR_SPIN} in a row</b> wins back a spin</li>
          </ul>
        </div>
        <div class="col">
          <p class="mode-label" id="mode-label">Choose your questions</p>
          <div class="modes" role="group" aria-labelledby="mode-label">
            ${MODE_KEYS.map((k) => `
              <button type="button" class="mode ${k}" data-mode="${k}" aria-pressed="false">
                <b>${MODES[k].label}</b><span>${MODES[k].sub}</span>
              </button>`).join("")}
          </div>
          <button class="primary" id="go" type="button">Throw the rock</button>
          <p class="best" id="best-line" hidden></p>
          <p class="hint">Tip: 1–3 picks questions, Enter throws, 1–4 answers</p>
          ${contributeLinks}
        </div>
      </div>`;
    for (const b of overlay.querySelectorAll(".mode")) b.addEventListener("click", () => setMode(b.dataset.mode));
    $("go").addEventListener("click", startGame);
    setMode(mode);
    showMenu();
    if (fromUser) focusEl($("go"));
    updateHud();
    updateDistance();
  }

  function startGame() {
    if (!["title", "over", "won"].includes(state)) return;
    run++;
    getAudio(); // unlock audio on user gesture
    spin = MAX_SPIN; streak = 0; right = 0; asked = 0;
    rock = { km: 0, y: -30 * unit(), rot: 0, tilt: 0, sink: 0 };
    ripples = []; drops = []; bubbles = [];
    lastDist = -1;
    hide(overlay);
    app.classList.remove("menu");
    hide(card);
    updateHud();
    queueSkips([24, 14]);
  }

  function endGame(won) {
    state = won ? "won" : "over";
    const dist = Math.round(rock.km);
    const isBest = dist > (bests[mode] || 0);
    if (isBest) { bests[mode] = dist; store.set("std-bests", bests); }
    const best = bests[mode] || 0;
    const left = GOAL_KM - dist;
    const quip = won ? "Sweet as! The Kiwis are lining up to shake your hand."
      : dist < 300 ? "Barely past the Bondi lifeguards."
      : dist < 1000 ? "Respectable. The seagulls are impressed."
      : dist < 1700 ? "Past halfway! You could almost hear the haka."
      : "So close you could smell the mince and cheese pies.";

    overlay.innerHTML = `
      <div class="panel split">
        <div class="col">
          <p class="kicker">${won ? "You made it!" : "Glub glub…"}</p>
          <h1>${won ? "You skipped the Ditch!" : `Sunk at ${fmt(dist)} km`}</h1>
          ${isBest && right > 0 ? `<span class="badge">New personal best</span>` : ""}
          <p class="lede">${quip}${won ? "" : ` Only ${fmt(left)} km to Auckland.`}</p>
        </div>
        <div class="col">
          <div class="stats">
            <div><b>${fmt(dist)}</b><span>km</span></div>
            <div><b>${right}/${asked}</b><span>correct</span></div>
            <div><b>${fmt(best)}</b><span>best km</span></div>
          </div>
          <div class="btn-row">
            <button class="primary" id="again" type="button">Throw again</button>
            <button class="secondary" id="share" type="button">Share</button>
          </div>
          <p class="mode-note">Questions: <b>${MODES[mode].label}</b> · <button class="link" id="change" type="button">Change</button></p>
          ${contributeLinks}
        </div>
      </div>`;
    $("again").addEventListener("click", startGame);
    $("change").addEventListener("click", () => titleScreen(true));
    $("share").addEventListener("click", (e) => share(e.currentTarget, dist, won));
    showMenu();
    focusEl($("again"));
    announce(won ? `You made it to Auckland! ${right} of ${asked} correct.` : `Your rock sank at ${fmt(dist)} kilometres. ${right} of ${asked} correct.`);
  }

  async function share(btn, dist, won) {
    const url = /^https?:/.test(location.href) ? location.href : "";
    const text = won
      ? `I skimmed a rock all ${fmt(GOAL_KM)} km from Bondi to Auckland 🪨🌊 (${right}/${asked} ${MODES[mode].share} trivia correct). Can you skip the Ditch?`
      : `My rock sank ${fmt(dist)} km across the Tasman 🪨🌊 (${right}/${asked} ${MODES[mode].share} trivia correct). Can you skip the Ditch?`;
    try {
      if (navigator.share) { await navigator.share({ title: "Skip the Ditch", text, url: url || undefined }); return; }
      await navigator.clipboard.writeText(url ? `${text} ${url}` : text);
      btn.textContent = "Copied!";
    } catch (err) {
      if (err && err.name === "AbortError") return; // user closed the share sheet
      btn.textContent = "Couldn't share";
    }
  }

  // ---------- Questions ----------
  function showQuestion() {
    current = drawQuestion();
    asked++;
    tagEl.textContent = TAGS[current.c] || "Trivia";
    tagEl.className = "tag " + current.c;
    qnumEl.textContent = `Bounce ${asked}`;
    questionEl.textContent = current.q;
    factEl.textContent = "";
    factEl.classList.remove("show");
    reportEl.hidden = true; // only offered once the answer is revealed
    answersEl.innerHTML = "";
    const opts = shuffle(current.a.map((text, i) => ({ text, correct: i === 0 })));
    opts.forEach((o, i) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "answer";
      b.innerHTML = `<kbd>${i + 1}</kbd><span></span>`;
      b.querySelector("span").textContent = o.text;
      if (o.correct) b.dataset.correct = "1";
      b.addEventListener("click", () => answer(b));
      answersEl.appendChild(b);
    });
    timerFill.style.transform = "scaleX(1)";
    timerFill.classList.remove("low");
    show(card);
    focusEl(card);
    announce(`${TAGS[current.c] || "Trivia"} question. ${current.q} ` +
      opts.map((o, i) => `${i + 1}: ${o.text}.`).join(" "));
    state = "question";
    qStart = performance.now();
  }

  function answer(btn) {
    if (state !== "question") return;
    state = "feedback";
    const remaining = Math.max(0, QUESTION_TIME - (performance.now() - qStart) / 1000);
    const frac = remaining / QUESTION_TIME;
    const ok = !!(btn && btn.dataset.correct);

    for (const b of answersEl.children) {
      b.disabled = true;
      if (b.dataset.correct) b.classList.add("correct");
    }
    if (btn && !ok) btn.classList.add("wrong");
    if (current.f) { factEl.textContent = current.f; factEl.classList.add("show"); }
    const correctText = current.a[0];
    reportEl.href = issueLink("report-question.yml", {
      title: `[Report] ${current.q}`,
      question: current.q,
      "listed-answer": correctText,
    });
    reportEl.hidden = false;

    const r = run;
    if (ok) {
      right++; streak++;
      sfx.right();
      let bonus = "";
      if (streak % STREAK_FOR_SPIN === 0 && spin < MAX_SPIN) { spin++; bonus = " · +1 spin!"; }
      const km = Math.round(55 + 95 * frac + Math.min(streak, 8) * 5);
      const skips = frac > 0.6 ? 3 : frac > 0.3 ? 2 : 1;
      toast(`+${km} km${bonus}`, "good");
      announce(`Correct! Plus ${km} kilometres.${bonus ? " You won back a spin." : ""} ${current.f || ""}`);
      updateHud();
      setTimeout(() => {
        if (r !== run) return;
        hide(card);
        queueSkips(splitKm(km, skips));
      }, 1600);
    } else {
      streak = 0; spin--;
      sfx.wrong();
      toast(btn ? "Wobble! −1 spin" : "Too slow! −1 spin", "bad");
      announce(`${btn ? "Wrong" : "Time's up"}. The answer was ${correctText}. ${spin} ${spin === 1 ? "spin" : "spins"} left. ${current.f || ""}`);
      updateHud();
      setTimeout(() => {
        if (r !== run) return;
        hide(card);
        if (spin <= 0) sink();
        else { wobbleNext = true; queueSkips([10]); }
      }, 2800);
    }
  }

  function splitKm(km, n) {
    const w = n === 3 ? [0.5, 0.3, 0.2] : n === 2 ? [0.62, 0.38] : [1];
    return w.map((x) => km * x);
  }

  // ---------- Flight ----------
  function queueSkips(lengths) {
    segments = lengths.slice();
    nextSegment();
  }

  function nextSegment() {
    const len = segments.shift();
    const fromKm = rock.km;
    const toKm = Math.min(fromKm + len, GOAL_KM);
    const px = (toKm - fromKm) * ppk();
    flight = {
      fromKm, toKm,
      fromY: rock.y,
      t: 0,
      dur: 0.4 + Math.min(px / 600, 1) * 0.65,
      h: Math.min(H * 0.28, 14 + px * 0.3),
      wobble: wobbleNext,
    };
    wobbleNext = false;
    state = "flying";
  }

  function land() {
    const km = flight.toKm;
    flight = null;
    rock.y = 0;
    sfx.skip();
    if (km >= GOAL_KM) {
      segments = [];
      splash(km, 1.4, true);
      state = "winning";
      sfx.win();
      const r = run;
      setTimeout(() => { if (r === run) endGame(true); }, 1400);
      return;
    }
    splash(km, 1);
    if (segments.length) {
      nextSegment();
    } else {
      state = "waiting";
      hoverRipple = 0.6;
      const r = run;
      setTimeout(() => { if (r === run) showQuestion(); }, 250);
    }
  }

  function sink() {
    state = "sinking";
    rock.sink = 0;
    sfx.sink();
    splash(rock.km, 0.6);
    const r = run;
    setTimeout(() => { if (r === run) endGame(false); }, 1900);
  }

  function splash(km, power, confetti) {
    ripples.push({ km, age: 0, big: true });
    const n = Math.round(12 * power);
    const colors = ["#ffcd00", "#00843d", "#ffffff", "#111111", "#ff7a3d"];
    for (let i = 0; i < n * (confetti ? 3 : 1); i++) {
      drops.push({
        km, dx: 0, y: -2,
        vx: (Math.random() * 2 - 0.5) * 70 * power,
        vy: -(90 + Math.random() * 140) * power * (confetti ? 1.8 : 1),
        life: confetti ? 1.6 : 0.9,
        color: confetti ? colors[i % colors.length] : null,
      });
    }
  }

  // ---------- Update ----------
  function update(dt, now) {
    time += dt;

    // Keep the waterline above the question card so the rock stays visible
    // (On short landscape screens the card docks to the right instead, leaving the sea clear.)
    const cr = card.getBoundingClientRect();
    const docked = cr.left > W * 0.4;
    const target = docked ? H * 0.62 : Math.max(130, H * 0.25, Math.min(H * 0.62, cr.top - 40 * unit()));
    waterY += (target - waterY) * Math.min(1, dt * 3);

    if (flight) {
      flight.t += dt;
      const p = Math.min(1, flight.t / flight.dur);
      rock.km = flight.fromKm + (flight.toKm - flight.fromKm) * p;
      rock.y = flight.fromY * (1 - p) - flight.h * 4 * p * (1 - p);
      rock.rot += dt * 20;
      rock.tilt = flight.wobble ? Math.sin(time * 28) * 0.4 : -0.06;
      if (p >= 1) land();
    } else if (state === "waiting" || state === "question" || state === "feedback") {
      const hoverY = -6 + Math.sin(time * 2.2) * 2;
      rock.y += (hoverY - rock.y) * Math.min(1, dt * 6);
      rock.rot += dt * 5;
      rock.tilt = Math.sin(time * 1.7) * 0.06;
      hoverRipple -= dt;
      if (hoverRipple <= 0) { ripples.push({ km: rock.km, age: 0 }); hoverRipple = 1.1; }
    } else if (state === "sinking") {
      rock.sink += dt;
      rock.y = rock.sink * 34;
      rock.tilt = 0.5 + rock.sink * 0.4;
      if (Math.random() < dt * 14) {
        bubbles.push({ km: rock.km, dx: (Math.random() - 0.5) * 14, y: rock.y, life: 1.2, r: 1.5 + Math.random() * 2.5 });
      }
    } else if (state === "title") {
      rock.y = -30 * unit();
    }

    camKm += (rock.km - camKm) * Math.min(1, dt * 6);

    if (state === "question") {
      const rem = QUESTION_TIME - (now - qStart) / 1000;
      timerFill.style.transform = `scaleX(${Math.max(0, rem / QUESTION_TIME)})`;
      timerFill.classList.toggle("low", rem < 4);
      if (rem <= 0) answer(null);
    }

    for (const r of ripples) r.age += dt;
    ripples = ripples.filter((r) => r.age < 1.8);

    for (const d of drops) {
      d.life -= dt;
      d.vy += 480 * dt;
      d.dx += d.vx * dt;
      d.y += d.vy * dt;
    }
    drops = drops.filter((d) => d.life > 0 && d.y < 8);

    for (const b of bubbles) { b.life -= dt; b.y -= 28 * dt; b.dx += Math.sin(time * 6 + b.r) * 6 * dt; }
    bubbles = bubbles.filter((b) => b.life > 0 && b.y > 0);

    updateDistance();
  }

  // ---------- Drawing ----------
  const clouds = Array.from({ length: 9 }, (_, i) => ({
    x: (i * 0.371) % 1,
    y: 0.12 + ((i * 37) % 10) / 10 * 0.45,
    s: 0.6 + ((i * 53) % 10) / 18,
  }));

  function drawSky(wy) {
    const g = ctx.createLinearGradient(0, 0, 0, wy);
    g.addColorStop(0, "#4fa8df");
    g.addColorStop(1, "#d4eef9");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, wy + 4);

    // sun
    const r = Math.min(W, H) * 0.06;
    ctx.fillStyle = "rgba(255, 244, 200, 0.5)";
    ctx.beginPath(); ctx.arc(W * 0.84, wy * 0.42, r * 1.6, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#fff4c4";
    ctx.beginPath(); ctx.arc(W * 0.84, wy * 0.42, r, 0, Math.PI * 2); ctx.fill();

    // clouds (parallax)
    const span = W + 400;
    ctx.fillStyle = "#f7fcff";
    for (const c of clouds) {
      const x = (((c.x * span - camKm * ppk() * 0.12 - time * 5) % span) + span) % span - 200;
      const y = c.y * wy;
      const s = c.s * Math.max(36, W * 0.045);
      blob(x, y, s * 1.4, s * 0.42);
      blob(x - s * 0.7, y + s * 0.06, s * 0.7, s * 0.36);
      blob(x + s * 0.35, y - s * 0.22, s * 0.75, s * 0.48);
    }
  }
  function blob(x, y, rx, ry) { ctx.beginPath(); ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2); ctx.fill(); }

  function drawShores(wy) {
    const u = unit();

    // --- Start: Bondi-style sandstone headland + beach + thrower ---
    const x0 = sx(0);
    if (x0 > -60) {
      ctx.fillStyle = "#c98f58";
      ctx.beginPath();
      ctx.moveTo(x0 - 3000, wy + 6);
      ctx.lineTo(x0 - 3000, wy - 92 * u);
      ctx.lineTo(x0 - 160 * u, wy - 92 * u);
      ctx.quadraticCurveTo(x0 - 100 * u, wy - 90 * u, x0 - 86 * u, wy - 40 * u);
      ctx.lineTo(x0 - 76 * u, wy + 6);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = "#a8723f";
      ctx.fillRect(x0 - 3000, wy - 60 * u, 3000 - 150 * u, 4 * u);
      ctx.fillStyle = "#5f8f3e";
      ctx.fillRect(x0 - 3000, wy - 98 * u, 3000 - 156 * u, 8 * u);

      ctx.fillStyle = "#f1d9a6";
      ctx.beginPath();
      ctx.moveTo(x0 - 3000, wy + 6);
      ctx.lineTo(x0 - 3000, wy - 8 * u);
      ctx.lineTo(x0 - 70 * u, wy - 8 * u);
      ctx.quadraticCurveTo(x0 - 10 * u, wy - 7 * u, x0 + 14 * u, wy + 6);
      ctx.closePath();
      ctx.fill();

      // thrower
      const fx = x0 - 24 * u, feet = wy - 8 * u;
      ctx.strokeStyle = "#1d2b36";
      ctx.lineWidth = 3 * u;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(fx - 6 * u, feet); ctx.lineTo(fx, feet - 14 * u); ctx.lineTo(fx + 6 * u, feet); // legs
      ctx.moveTo(fx, feet - 14 * u); ctx.lineTo(fx, feet - 30 * u);                             // body
      const holding = state === "title";
      ctx.moveTo(fx, feet - 26 * u);
      if (holding) ctx.lineTo(fx + 20 * u, feet - 24 * u);   // arm out holding rock
      else ctx.lineTo(fx + 14 * u, feet - 40 * u);            // arm up celebrating
      ctx.moveTo(fx, feet - 26 * u); ctx.lineTo(fx - 10 * u, feet - 18 * u);
      ctx.stroke();
      ctx.fillStyle = "#1d2b36";
      ctx.beginPath(); ctx.arc(fx, feet - 36 * u, 5.5 * u, 0, Math.PI * 2); ctx.fill();
    }

    // --- Finish: Auckland hills + Sky Tower ---
    const x1 = sx(GOAL_KM);
    if (x1 < W + 60) {
      ctx.fillStyle = "#7aa86a";
      ctx.beginPath();
      ctx.moveTo(x1 + 60 * u, wy + 6);
      ctx.quadraticCurveTo(x1 + 200 * u, wy - 150 * u, x1 + 340 * u, wy - 110 * u);
      ctx.quadraticCurveTo(x1 + 480 * u, wy - 70 * u, x1 + 3000, wy - 130 * u);
      ctx.lineTo(x1 + 3000, wy + 6);
      ctx.closePath();
      ctx.fill();

      const tx = x1 + 250 * u;
      ctx.fillStyle = "#e4e9ed";
      ctx.fillRect(tx - 3.5 * u, wy - 210 * u, 7 * u, 170 * u);
      ctx.beginPath(); ctx.ellipse(tx, wy - 175 * u, 15 * u, 8 * u, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "#9fb4c2";
      ctx.fillRect(tx - 15 * u, wy - 177 * u, 30 * u, 3 * u);
      ctx.strokeStyle = "#e4e9ed";
      ctx.lineWidth = 2 * u;
      ctx.beginPath(); ctx.moveTo(tx, wy - 210 * u); ctx.lineTo(tx, wy - 255 * u); ctx.stroke();

      ctx.fillStyle = "#4e8a3a";
      ctx.beginPath();
      ctx.moveTo(x1 + 20 * u, wy + 6);
      ctx.quadraticCurveTo(x1 + 110 * u, wy - 80 * u, x1 + 190 * u, wy - 50 * u);
      ctx.quadraticCurveTo(x1 + 300 * u, wy - 20 * u, x1 + 420 * u, wy - 70 * u);
      ctx.quadraticCurveTo(x1 + 560 * u, wy - 110 * u, x1 + 3000, wy - 60 * u);
      ctx.lineTo(x1 + 3000, wy + 6);
      ctx.closePath();
      ctx.fill();

      ctx.fillStyle = "#f1d9a6";
      ctx.beginPath();
      ctx.moveTo(x1 - 14 * u, wy + 6);
      ctx.quadraticCurveTo(x1 + 10 * u, wy - 7 * u, x1 + 70 * u, wy - 8 * u);
      ctx.lineTo(x1 + 3000, wy - 8 * u);
      ctx.lineTo(x1 + 3000, wy + 6);
      ctx.closePath();
      ctx.fill();

      // welcome flag
      ctx.strokeStyle = "#333"; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(x1 + 40 * u, wy - 8 * u); ctx.lineTo(x1 + 40 * u, wy - 48 * u); ctx.stroke();
      ctx.fillStyle = "#111";
      ctx.beginPath();
      ctx.moveTo(x1 + 40 * u, wy - 48 * u);
      ctx.lineTo(x1 + 64 * u, wy - 42 * u + Math.sin(time * 4) * 2);
      ctx.lineTo(x1 + 40 * u, wy - 36 * u);
      ctx.closePath();
      ctx.fill();
    }
  }

  function drawBuoys(wy) {
    ctx.textAlign = "center";
    ctx.font = "800 12px Nunito, system-ui, sans-serif";
    for (let k = 250; k < GOAL_KM; k += 250) {
      const x = sx(k);
      if (x < -60 || x > W + 60) continue;
      const b = Math.sin(time * 2 + k) * 2;
      ctx.strokeStyle = "#2b2b2b"; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(x, wy - 12 + b); ctx.lineTo(x, wy - 30 + b); ctx.stroke();
      ctx.fillStyle = "#ffcd00";
      ctx.beginPath(); ctx.moveTo(x, wy - 30 + b); ctx.lineTo(x + 12, wy - 26 + b); ctx.lineTo(x, wy - 22 + b); ctx.fill();
      ctx.fillStyle = "#e0442f";
      ctx.beginPath();
      ctx.moveTo(x - 9, wy + 3 + b); ctx.lineTo(x + 9, wy + 3 + b);
      ctx.lineTo(x + 5, wy - 13 + b); ctx.lineTo(x - 5, wy - 13 + b);
      ctx.closePath(); ctx.fill();
      ctx.fillStyle = "#fff";
      ctx.fillRect(x - 6, wy - 7 + b, 12, 3);
      const label = k === 1000 ? "1,000 km · nearly halfway" : `${fmt(k)} km`;
      ctx.lineWidth = 3; ctx.strokeStyle = "rgba(15,42,61,0.55)";
      ctx.strokeText(label, x, wy - 38 + b);
      ctx.fillStyle = "#fff";
      ctx.fillText(label, x, wy - 38 + b);
    }
  }

  function drawWater(wy) {
    const off = camKm * ppk();
    const depth = H - wy;
    const layers = [
      { c: "#3b9ed3", amp: 3, f: 0.02, sp: 1.3, y: 0, par: 1 },
      { c: "#2a85bb", amp: 4, f: 0.013, sp: 0.9, y: depth * 0.22, par: 1.25 },
      { c: "#1f6fa3", amp: 5, f: 0.009, sp: 0.7, y: depth * 0.5, par: 1.5 },
    ];
    for (const L of layers) {
      ctx.fillStyle = L.c;
      ctx.beginPath();
      ctx.moveTo(0, H);
      for (let x = 0; x <= W + 12; x += 12) {
        const wx = x + off * L.par;
        const y = wy + L.y + Math.sin(wx * L.f + time * L.sp) * L.amp + Math.sin(wx * L.f * 2.3 - time * L.sp * 1.3) * L.amp * 0.4;
        ctx.lineTo(x, y);
      }
      ctx.lineTo(W, H);
      ctx.closePath();
      ctx.fill();
    }
    // glints
    ctx.strokeStyle = "rgba(255,255,255,0.5)";
    ctx.lineWidth = 2;
    ctx.lineCap = "round";
    const span = W + 120;
    for (let i = 0; i < 28; i++) {
      const a = 0.5 + 0.5 * Math.sin(time * 2.5 + i * 1.7);
      if (a < 0.4) continue;
      const x = (((i * 173.3 - off * (1 + (i % 3) * 0.25)) % span) + span) % span - 60;
      const y = wy + 8 + ((i * 41) % 100) / 100 * (depth - 16);
      ctx.globalAlpha = a;
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + 10 + (i % 4) * 4, y); ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  function drawRipples(wy) {
    ctx.lineWidth = 2;
    for (const r of ripples) {
      const x = sx(r.km);
      const max = r.big ? 1 : 0.55;
      const rad = (8 + r.age * 55) * max * unit();
      ctx.strokeStyle = `rgba(255,255,255,${Math.max(0, 0.8 - r.age / 1.8) * max})`;
      ctx.beginPath(); ctx.ellipse(x, wy + 2, rad, rad * 0.22, 0, 0, Math.PI * 2); ctx.stroke();
    }
  }

  function drawRock(wy) {
    const x = sx(rock.km);
    const y = wy - 5 + rock.y;
    const R = 11 * unit();

    if (rock.y < -3 && state !== "title") {
      const s = Math.max(0.25, 1 - -rock.y / 220);
      ctx.fillStyle = `rgba(10,40,70,${0.28 * s})`;
      ctx.beginPath(); ctx.ellipse(x, wy + 2, R * 1.1 * s, R * 0.25 * s, 0, 0, Math.PI * 2); ctx.fill();
    }

    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(rock.tilt);
    const g = ctx.createLinearGradient(0, -R * 0.5, 0, R * 0.5);
    g.addColorStop(0, "#c4bfb5");
    g.addColorStop(1, "#5c5751");
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.ellipse(0, 0, R, R * 0.42, 0, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = "rgba(20,20,20,0.35)";
    ctx.lineWidth = 1;
    ctx.stroke();
    // spinning glint shows rotation
    ctx.fillStyle = "rgba(255,255,255,0.6)";
    ctx.beginPath();
    ctx.ellipse(Math.cos(rock.rot) * R * 0.55, -R * 0.1, R * 0.2 * Math.abs(Math.sin(rock.rot)) + R * 0.06, R * 0.08, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  function drawParticles(wy) {
    for (const d of drops) {
      ctx.fillStyle = d.color || `rgba(255,255,255,${Math.min(1, d.life * 1.5)})`;
      const r = d.color ? 3 : 2.2;
      ctx.beginPath(); ctx.arc(sx(d.km) + d.dx, wy + d.y, r, 0, Math.PI * 2); ctx.fill();
    }
    ctx.strokeStyle = "rgba(255,255,255,0.7)";
    ctx.lineWidth = 1.2;
    for (const b of bubbles) {
      ctx.beginPath(); ctx.arc(sx(b.km) + b.dx, wy + b.y, b.r, 0, Math.PI * 2); ctx.stroke();
    }
  }

  function draw() {
    const wy = waterY;
    drawSky(wy);
    drawShores(wy);
    drawBuoys(wy);
    if (state === "sinking" || state === "over") {
      drawRock(wy);   // under the water surface
      drawWater(wy);
    } else {
      drawWater(wy);
      drawRipples(wy);
      drawRock(wy);
    }
    drawParticles(wy);
  }

  // ---------- Input ----------
  document.addEventListener("keydown", (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
    // Let a focused button handle its own Enter/Space (mode picker, Share, etc.)
    const onControl = e.target instanceof Element && e.target.closest("button, a, input, select, textarea");
    if (state === "question") {
      const k = "1234".indexOf(e.key) >= 0 ? "1234".indexOf(e.key) : "abcd".indexOf(e.key.toLowerCase());
      if (k >= 0 && answersEl.children[k]) answersEl.children[k].click();
    } else if (state === "title" && "123".includes(e.key) && e.key.length === 1) {
      setMode(MODE_KEYS[Number(e.key) - 1]);
    } else if (!onControl && ["title", "over", "won"].includes(state) && (e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      startGame();
    }
  });

  // ---------- Loop ----------
  let last = performance.now();
  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    update(dt, now);
    draw();
    requestAnimationFrame(frame);
  }

  titleScreen();
  requestAnimationFrame(frame);
})();
