// Hero animation: a physical work cell (left) mirrored by its digital twin (right).
// One simulation state drives both renderers; the twin also draws a dashed "predicted"
// pose a little ahead in time. Sensor packets flow left -> right, commands flow back.
// Plain Canvas 2D + requestAnimationFrame; pauses off-screen and honors reduced motion.
(() => {
  const canvas = document.getElementById("twin");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const css = getComputedStyle(document.documentElement);
  const C = {
    solid: "#c3c2b7", dim: "#39404c", belt: "#2a2f39", box: "#d9a441",
    twin: css.getPropertyValue("--accent").trim() || "#76b900", cmd: "#3987e5", text: "#8d8c86",
  };
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const CYCLE = 4.0;            // seconds per pick-and-place
  const LOOKAHEAD = 0.35;       // twin prediction horizon (s)
  let W = 0, H = 0, dpr = 1, running = true, t0 = performance.now();
  const packets = [];

  function resize() {
    dpr = Math.min(devicePixelRatio || 1, 2);
    const r = canvas.getBoundingClientRect();
    W = r.width; H = r.height;
    canvas.width = W * dpr; canvas.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  // ---- shared simulation state -------------------------------------------------
  const ease = (x) => x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2;
  function state(t) {
    const p = (t % CYCLE) / CYCLE;           // phase 0..1
    // arm: reach to belt end (0..0.3), lift+swing to pallet (0.3..0.7), return (0.7..1)
    let swing;
    if (p < 0.3) swing = 0;
    else if (p < 0.7) swing = ease((p - 0.3) / 0.4);
    else swing = 1 - ease((p - 0.7) / 0.3);
    const holding = p >= 0.3 && p < 0.7;
    const placed = Math.floor(t / CYCLE) % 6 + (p >= 0.7 ? 1 : 0);
    return { p, swing, holding, placed, beltOffset: (t * 28) % 40 };
  }

  // ---- renderer: same geometry, two styles --------------------------------------
  function scene(x0, w, s, style) {
    const twin = style !== "physical";
    const stroke = style === "physical" ? C.solid : C.twin;
    const sx = w / 360, sy = H / 360;   // scene authored in a 360x360 box
    const X = (x) => x0 + x * sx, Y = (y) => y * sy;
    ctx.save();
    ctx.lineWidth = twin ? 1.2 : 1.5;
    ctx.strokeStyle = stroke;
    if (style === "predicted") { ctx.setLineDash([4, 4]); ctx.globalAlpha = 0.55; }

    if (style !== "predicted") {
      // floor grid on the twin side
      if (twin) {
        ctx.save(); ctx.strokeStyle = C.dim; ctx.lineWidth = 0.6;
        for (let gx = 20; gx <= 340; gx += 20) { ctx.beginPath(); ctx.moveTo(X(gx), Y(250)); ctx.lineTo(X(gx), Y(330)); ctx.stroke(); }
        for (let gy = 250; gy <= 330; gy += 20) { ctx.beginPath(); ctx.moveTo(X(20), Y(gy)); ctx.lineTo(X(340), Y(gy)); ctx.stroke(); }
        ctx.restore();
      }
      // conveyor belt
      ctx.fillStyle = twin ? "transparent" : C.belt;
      ctx.beginPath(); ctx.rect(X(20), Y(220), 170 * sx, 18 * sy); twin ? ctx.stroke() : (ctx.fill(), ctx.stroke());
      for (let i = 0; i < 6; i++) {               // rollers / moving boxes
        const bx = 20 + ((i * 40 + s.beltOffset) % 160);
        if (bx > 160) continue;                    // box reaches the pick point and disappears into the gripper
        ctx.beginPath(); ctx.rect(X(bx), Y(198), 20 * sx, 20 * sy);
        if (twin) ctx.stroke(); else { ctx.fillStyle = C.box; ctx.fill(); }
      }
      // pallet with stacked boxes
      ctx.beginPath(); ctx.rect(X(250), Y(232), 80 * sx, 8 * sy); ctx.stroke();
      for (let i = 0; i < s.placed; i++) {
        const col = i % 3, row = Math.floor(i / 3);
        ctx.beginPath(); ctx.rect(X(254 + col * 25), Y(210 - row * 22), 22 * sx, 20 * sy);
        if (twin) ctx.stroke(); else { ctx.fillStyle = C.box; ctx.fill(); }
      }
      // camera sensor + field of view
      ctx.beginPath(); ctx.rect(X(90), Y(40), 22 * sx, 14 * sy); ctx.stroke();
      ctx.save(); ctx.globalAlpha = twin ? 0.08 : 0.05; ctx.fillStyle = twin ? C.twin : C.solid;
      ctx.beginPath(); ctx.moveTo(X(101), Y(54)); ctx.lineTo(X(40), Y(196)); ctx.lineTo(X(170), Y(196)); ctx.closePath(); ctx.fill();
      ctx.globalAlpha = twin ? 0.45 : 0.3; ctx.setLineDash([2, 4]); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(X(40), Y(196)); ctx.lineTo(X(101), Y(54)); ctx.lineTo(X(170), Y(196)); ctx.stroke(); ctx.restore();
    }

    // robot arm: base at (210,240); two links; angle from swing
    const base = [210, 240], L1 = 70, L2 = 62;
    const a1 = (-120 + s.swing * 70) * Math.PI / 180;   // shoulder
    const a2 = (-40 + s.swing * 10) * Math.PI / 180;    // elbow, relative
    const j = [base[0] + L1 * Math.cos(a1), base[1] + L1 * Math.sin(a1)];
    const e = [j[0] + L2 * Math.cos(a1 + a2 + 1.2), j[1] + L2 * Math.sin(a1 + a2 + 1.2)];
    ctx.lineWidth = twin ? 1.4 : 6; ctx.lineCap = "round";
    ctx.beginPath(); ctx.moveTo(X(base[0]), Y(base[1])); ctx.lineTo(X(j[0]), Y(j[1])); ctx.lineTo(X(e[0]), Y(e[1])); ctx.stroke();
    ctx.lineWidth = twin ? 1.2 : 1.5;
    ctx.beginPath(); ctx.arc(X(base[0]), Y(base[1]), 9 * sx, 0, Math.PI * 2); ctx.stroke();
    if (s.holding) {
      ctx.beginPath(); ctx.rect(X(e[0] - 10), Y(e[1] + 2), 20 * sx, 20 * sy);
      if (twin) ctx.stroke(); else { ctx.fillStyle = C.box; ctx.fill(); }
    }
    ctx.restore();
    return { cam: [X(101), Y(47)], arm: [X(base[0]), Y(base[1])] };
  }

  function frame(now) {
    const t = reduced ? 1.2 : (now - t0) / 1000;
    ctx.clearRect(0, 0, W, H);
    const half = W / 2, pad = 10;
    const s = state(t);
    const phys = scene(pad, half - 2 * pad, s, "physical");
    scene(half + pad, half - 2 * pad, s, "twin");
    scene(half + pad, half - 2 * pad, state(t + LOOKAHEAD), "predicted");

    // divider
    ctx.strokeStyle = C.dim; ctx.setLineDash([3, 5]);
    ctx.beginPath(); ctx.moveTo(half, 40); ctx.lineTo(half, H - 30); ctx.stroke(); ctx.setLineDash([]);

    // packets: sensor data -> twin (accent), commands -> robot (blue)
    if (!reduced && Math.random() < 0.18) packets.push({ x: phys.cam[0], y: phys.cam[1], dir: 1, life: 0 });
    if (!reduced && Math.random() < 0.05) packets.push({ x: half + phys.arm[0], y: phys.arm[1], dir: -1, life: 0 });
    for (let i = packets.length - 1; i >= 0; i--) {
      const k = packets[i]; k.life += 1;
      k.x += 3.2 * k.dir; k.y += Math.sin((k.life + i) / 6) * 0.6;
      if (k.life > 400 || k.x > W || k.x < 0) { packets.splice(i, 1); continue; }
      ctx.fillStyle = k.dir > 0 ? C.twin : C.cmd;
      ctx.beginPath(); ctx.arc(k.x, k.y, 2.2, 0, Math.PI * 2); ctx.fill();
    }
    ctx.fillStyle = C.text; ctx.font = "11px ui-monospace, Menlo, monospace";
    ctx.fillText("sensor stream →", half - 108, H - 14);
    ctx.fillText("← control / what-if", half + 12, H - 14);

    // telemetry (illustrative numbers derived from the sim, not real data)
    if (Math.floor(t * 4) !== frame.lastTick) {
      frame.lastTick = Math.floor(t * 4);
      const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
      set("tm-rate", (60 / CYCLE).toFixed(0) + "/min");
      set("tm-lat", (14 + Math.round(Math.sin(t) * 3 + Math.random() * 4)) + " ms");
      set("tm-ahead", (LOOKAHEAD * 1000).toFixed(0) + " ms");
      set("tm-boxes", String(Math.floor(t / CYCLE)));
    }
    if (running && !reduced) requestAnimationFrame(frame);
  }

  resize();
  addEventListener("resize", () => { resize(); if (reduced) frame(0); });
  new IntersectionObserver(([e]) => {
    const was = running; running = e.isIntersecting;
    if (running && !was && !reduced) requestAnimationFrame(frame);
  }).observe(canvas);
  requestAnimationFrame(frame);
})();
