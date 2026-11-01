/* ---------------------------------------------------------------------
   AuthorLedger — 3D depth layer (depth.js)

   Dependency-free. Drives the CSS-3D hero book scene (idle sway, pointer
   parallax, drag-to-spin), pointer tilt + glare on cards, and the 3D
   scroll-reveal. Everything is set through CSS custom properties /
   classList, so the strict CSP (no inline styles, same-origin scripts)
   is untouched. Honors prefers-reduced-motion and coarse pointers.
   ------------------------------------------------------------------- */
(function () {
  "use strict";

  var root = document.documentElement;
  var reduceQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
  var fineQuery = window.matchMedia("(hover: hover) and (pointer: fine)");
  root.classList.add("depth-js");

  // ------------------------------------------------------- hero scene --

  var BASE_RY = -28;
  var BASE_RX = 6;

  function initScene(scene) {
    var rig = scene.querySelector(".scene3d-rig");
    if (!rig) return;
    var host = scene.closest(".hero") || scene;

    var ry = BASE_RY;
    var rx = BASE_RX;
    var spin = 0; // extra user-driven rotation (degrees), eases back to a full turn
    var pointerX = 0; // -1..1 relative to hero centre; null = idle
    var pointerY = 0;
    var hovering = false;
    var dragging = false;
    var lastX = 0;
    var lastY = 0;
    var tiltX = 0; // drag-driven pitch offset
    var visible = true;
    var rafId = 0;
    var lastRy = null;
    var lastRx = null;

    function frame(now) {
      rafId = 0;
      var reduce = reduceQuery.matches;
      var targetRy = BASE_RY;
      var targetRx = BASE_RX;

      if (!reduce && !dragging) {
        if (hovering) {
          targetRy += pointerX * 24;
          targetRx -= pointerY * 12;
        } else {
          targetRy += Math.sin(now / 2300) * 15;
          targetRx += Math.sin(now / 3100) * 2.5;
        }
      }
      if (!dragging) {
        // settle spin back to the nearest whole turn, and pitch back to rest
        spin += (Math.round(spin / 360) * 360 - spin) * 0.06;
        tiltX += (0 - tiltX) * 0.08;
      }
      ry += (targetRy + spin - ry) * (dragging ? 0.5 : 0.08);
      rx += (targetRx + tiltX - rx) * (dragging ? 0.5 : 0.08);

      if (lastRy === null || Math.abs(ry - lastRy) > 0.01 || Math.abs(rx - lastRx) > 0.01) {
        rig.style.setProperty("--rig-ry", ry.toFixed(2) + "deg");
        rig.style.setProperty("--rig-rx", rx.toFixed(2) + "deg");
        lastRy = ry;
        lastRx = rx;
      }
      schedule();
    }

    function schedule() {
      if (!rafId && visible && !document.hidden) rafId = requestAnimationFrame(frame);
    }

    host.addEventListener("pointermove", function (e) {
      if (e.pointerType === "touch" && !dragging) return;
      var r = host.getBoundingClientRect();
      pointerX = ((e.clientX - r.left) / r.width - 0.5) * 2;
      pointerY = ((e.clientY - r.top) / r.height - 0.5) * 2;
      hovering = true;
    });
    host.addEventListener("pointerleave", function () { hovering = false; });

    scene.addEventListener("pointerdown", function (e) {
      if (e.button !== undefined && e.button !== 0) return;
      dragging = true;
      lastX = e.clientX;
      lastY = e.clientY;
      scene.classList.add("is-dragging");
      if (scene.setPointerCapture) {
        try { scene.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      }
      schedule();
    });
    scene.addEventListener("pointermove", function (e) {
      if (!dragging) return;
      spin += (e.clientX - lastX) * 0.7;
      tiltX = Math.max(-25, Math.min(25, tiltX - (e.clientY - lastY) * 0.3));
      lastX = e.clientX;
      lastY = e.clientY;
    });
    function endDrag() {
      dragging = false;
      scene.classList.remove("is-dragging");
    }
    scene.addEventListener("pointerup", endDrag);
    scene.addEventListener("pointercancel", endDrag);

    if ("IntersectionObserver" in window) {
      new IntersectionObserver(function (entries) {
        visible = entries[0].isIntersecting;
        if (visible) schedule();
      }).observe(scene);
    }
    document.addEventListener("visibilitychange", schedule);
    schedule();
  }

  // ------------------------------------------------- card tilt + glare --

  var TILT_SELECTOR = ".dash-stat-card, .feature-card, .principle-card, .hero-report-card";
  var MAX_TILT = 7;
  var activeCard = null;

  function resetCard(card) {
    if (!card) return;
    card.classList.remove("is-tilting");
    card.style.removeProperty("--tilt-x");
    card.style.removeProperty("--tilt-y");
  }

  function onPointerMove(e) {
    if (!fineQuery.matches || reduceQuery.matches || e.pointerType === "touch") return;
    var target = e.target instanceof Element ? e.target.closest(TILT_SELECTOR) : null;
    if (target !== activeCard) {
      resetCard(activeCard);
      activeCard = target;
    }
    if (!target) return;
    var r = target.getBoundingClientRect();
    var px = (e.clientX - r.left) / r.width;
    var py = (e.clientY - r.top) / r.height;
    target.classList.add("is-tilting");
    target.style.setProperty("--tilt-x", ((0.5 - py) * 2 * MAX_TILT).toFixed(2) + "deg");
    target.style.setProperty("--tilt-y", ((px - 0.5) * 2 * MAX_TILT).toFixed(2) + "deg");
    target.style.setProperty("--glare-x", (px * 100).toFixed(1) + "%");
    target.style.setProperty("--glare-y", (py * 100).toFixed(1) + "%");
  }

  document.addEventListener("pointermove", onPointerMove, { passive: true });
  document.addEventListener("pointerleave", function () {
    resetCard(activeCard);
    activeCard = null;
  });
  window.addEventListener("blur", function () {
    resetCard(activeCard);
    activeCard = null;
  });

  // ---------------------------------------------------- scroll reveal --

  function initReveal() {
    var items = document.querySelectorAll(
      ".dash-stat-card, .feature-card, .principle-card, .faq-item, .panel-card"
    );
    if (!("IntersectionObserver" in window)) return;
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add("is-in");
          io.unobserve(entry.target);
        }
      });
    }, { threshold: 0.12 });
    items.forEach(function (el) {
      var sibling = Array.prototype.indexOf.call(el.parentElement.children, el);
      el.style.setProperty("--reveal-i", String(Math.min(sibling, 6)));
      el.classList.add("reveal-3d");
      io.observe(el);
    });
  }

  function init() {
    var scenes = document.querySelectorAll(".scene3d");
    for (var i = 0; i < scenes.length; i += 1) initScene(scenes[i]);
    initReveal();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
