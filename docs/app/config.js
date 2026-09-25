/* The website uses its own data directory. The extension prefers Pages and
 * falls back to the repository's published files if Pages is unavailable.
 * The APK build replaces this file with a full Pages URL. */
var isExtension = location.protocol === "chrome-extension:";
var panelView = isExtension && new URLSearchParams(location.search).get("view") === "panel";
window.FR_CONFIG = {
  extension: isExtension,
  panel: panelView,
  dataBase: "../data/",
  dataBases: isExtension ? [
    "https://arhaandev24.github.io/lpu-free-room/data/",
    "https://raw.githubusercontent.com/ArhaanDev24/lpu-free-room/main/docs/data/"
  ] : ["../data/"]
};
if (isExtension) {
  var webFonts = document.getElementById("webFonts");
  if (webFonts) webFonts.remove();
  document.querySelectorAll('link[rel="preconnect"]').forEach(function (link) { link.remove(); });
  document.documentElement.classList.add(panelView ? "extension-panel" : "extension-popup");
  var popupStyle = document.createElement("link");
  popupStyle.rel = "stylesheet";
  popupStyle.href = new URL("../../extension/popup.css", location.href).href;
  document.head.appendChild(popupStyle);
}
