// Runs before the app mounts so a dark-mode user doesn't see a light flash.
// A separate file (not an inline script) because the CSP is `script-src 'self'`.
try {
  var t = localStorage.getItem("mcp-gateway-theme");
  var dark =
    t === "dark" || (t === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  if (dark) document.documentElement.classList.add("dark");
} catch (e) {
  // Storage can be blocked; the default (light) theme is fine.
}
