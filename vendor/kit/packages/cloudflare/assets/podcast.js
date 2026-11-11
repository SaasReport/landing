/* Podcast player: enhances every [data-pp] block (the native <audio> stays the source).
   One episode plays at a time; on an episode page the [data-transcript] list follows playback
   (current line highlighted; click or Enter on a line seeks to it). */
(function () {
  "use strict";
  var S = {};
  try { S = JSON.parse(document.getElementById("kit-strings").textContent); } catch (e) { S = {}; /* no strings island: every label falls back to its built-in text */ }
  // Numbers through the kit's one formatter (/kit/format.js, loaded first: globalThis.KitFormat).
  var num = function (s) { return KitFormat.digits(s, S.lang || "en"); };
  var clock = function (sec) { return KitFormat.formatDuration(Math.floor(sec || 0), S.lang || "en"); };
  var RATES = [1, 1.25, 1.5, 0.75];

  function setup(root) {
    if (root.dataset.ready) return;
    root.dataset.ready = "1";
    var audio = root.querySelector("audio"), play = root.querySelector(".pp__play"), seek = root.querySelector(".pp__seek");
    var fill = root.querySelector(".pp__fill"), knob = root.querySelector(".pp__knob"), cur = root.querySelector(".pp__cur"), dur = root.querySelector(".pp__dur");
    var rate = root.querySelector(".pp__rate"), known = (+root.dataset.duration || 0) / 1000, dragging = false;
    var transcript = root.classList.contains("pp--big") ? document.querySelector("[data-transcript]") : null;
    var lines = transcript ? [].slice.call(transcript.querySelectorAll("li[data-start]")).filter(function (li) { return li.dataset.start !== ""; }) : [];
    var total = function () { return isFinite(audio.duration) && audio.duration > 0 ? audio.duration : known; };
    var label = play.getAttribute("aria-label") || "";

    function paint() {
      var t = audio.currentTime, d = total(), f = d ? Math.min(1, t / d) : 0;
      fill.style.width = f * 100 + "%";
      knob.style.insetInlineStart = "calc(" + f * 100 + "% - 7px)";
      if (!dragging) seek.value = Math.round(f * 1000);
      cur.textContent = clock(t);
      if (d) dur.textContent = clock(d);
      if (lines.length) {
        var ms = t * 1000, active = null;
        for (var i = 0; i < lines.length; i++) if (+lines[i].dataset.start <= ms + 150) active = lines[i];
        lines.forEach(function (li) { li.classList.toggle("is-on", li === active && !audio.paused); });
      }
    }
    function state() {
      root.classList.toggle("is-playing", !audio.paused);
      play.setAttribute("aria-label", audio.paused ? label : (S["podcasts.pause"] || "Pause"));
      paint();
    }
    play.addEventListener("click", function () {
      if (audio.paused) {
        document.querySelectorAll("[data-pp] audio").forEach(function (a) { if (a !== audio) a.pause(); });
        audio.play().catch(function () { if (window.KitNotify) window.KitNotify.show({ type: "error", title: S["podcasts.playFailed"] || "Playback failed" }); });
      } else audio.pause();
    });
    ["play", "pause", "ended"].forEach(function (ev) { audio.addEventListener(ev, state); });
    ["timeupdate", "loadedmetadata", "durationchange"].forEach(function (ev) { audio.addEventListener(ev, paint); });
    audio.addEventListener("waiting", function () { root.classList.add("is-loading"); });
    audio.addEventListener("playing", function () { root.classList.remove("is-loading"); });
    seek.addEventListener("input", function () {
      dragging = true;
      var f = seek.value / 1000;
      fill.style.width = f * 100 + "%"; knob.style.insetInlineStart = "calc(" + f * 100 + "% - 7px)";
      cur.textContent = clock(f * total());
    });
    seek.addEventListener("change", function () { dragging = false; if (total()) audio.currentTime = seek.value / 1000 * total(); paint(); });
    root.querySelectorAll("[data-skip]").forEach(function (b) {
      b.addEventListener("click", function () { audio.currentTime = Math.max(0, Math.min(total() || 0, audio.currentTime + +b.dataset.skip)); paint(); });
    });
    rate.addEventListener("click", function () {
      var i = (RATES.indexOf(audio.playbackRate) + 1) % RATES.length;
      audio.playbackRate = RATES[i];
      rate.textContent = num(String(RATES[i])) + "×";
    });
    lines.forEach(function (li) {
      li.tabIndex = 0;
      var go = function () { audio.currentTime = +li.dataset.start / 1000; if (audio.paused) play.click(); else paint(); };
      li.addEventListener("click", go);
      li.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } });
    });
    root.addEventListener("keydown", function (e) {
      if (e.target === seek) return;
      // the timeline is always left-to-right, also in RTL pages
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") { e.preventDefault(); audio.currentTime += (e.key === "ArrowRight" ? 5 : -5); paint(); }
    });
    paint();
  }

  window.KitPodcast = { mount: function (scope) { (scope || document).querySelectorAll("[data-pp]").forEach(setup); } };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", function () { window.KitPodcast.mount(); });
  else window.KitPodcast.mount();
})();
