// Light/dark theme toggle, persisted to localStorage. The no-flash setter runs
// inline in each page <head>; this only handles the toggle button.
window.toggleTheme = function () {
  var root = document.documentElement;
  var next = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  root.setAttribute('data-theme', next);
  try { localStorage.setItem('rl-theme', next); } catch (e) { /* ignore */ }
};
