/* Тема: «system» (за ОС), «light», «dark». Підключається в <head> без defer, щоб тема була
   застосована ще до першого малювання сторінки (без блимання). Вибір зберігається у localStorage. */
(function () {
  "use strict";
  var KEY = "analyst.theme.v1";
  var root = document.documentElement;
  var VALID = ["system", "light", "dark"];

  function read() {
    try { var v = localStorage.getItem(KEY); return VALID.indexOf(v) >= 0 ? v : "system"; } catch (e) { return "system"; }
  }
  function apply(mode) {
    if (mode === "system") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", mode);
    root.setAttribute("data-theme-mode", mode);
  }
  function effective() {
    var m = root.getAttribute("data-theme-mode") || "system";
    if (m !== "system") return m;
    return window.matchMedia && matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }

  apply(read());

  window.AppTheme = {
    mode: function () { return root.getAttribute("data-theme-mode") || "system"; },
    effective: effective,
    set: function (mode) {
      if (VALID.indexOf(mode) < 0) mode = "system";
      apply(mode);
      try { localStorage.setItem(KEY, mode); } catch (e) { /* без збереження теж працює */ }
      document.dispatchEvent(new CustomEvent("themechange"));
    },
  };

  // «Системна» тема змінюється разом з ОС
  if (window.matchMedia) {
    var mq = matchMedia("(prefers-color-scheme: dark)");
    var onChange = function () { if (window.AppTheme.mode() === "system") document.dispatchEvent(new CustomEvent("themechange")); };
    if (mq.addEventListener) mq.addEventListener("change", onChange); else if (mq.addListener) mq.addListener(onChange);
  }
})();
