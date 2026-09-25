/* The website uses its own data directory. The extension reads the same
 * published files from the repository, including before Pages is enabled.
 * The APK build replaces this file with a full Pages URL. */
var isExtension = location.protocol === "chrome-extension:";
window.FR_CONFIG = {
  dataBase: isExtension
    ? "https://raw.githubusercontent.com/ArhaanDev24/lpu-free-room/main/docs/data/"
    : "../data/"
};
if (isExtension) {
  var popupStyle = document.createElement("link");
  popupStyle.rel = "stylesheet";
  popupStyle.href = new URL("../../extension/popup.css", location.href).href;
  document.head.appendChild(popupStyle);
}
