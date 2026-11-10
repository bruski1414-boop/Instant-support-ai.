(() => {
  "use strict";
  const script = document.currentScript;
  if (!script || script.dataset.veyraWidgetLoaded === "true") return;
  script.dataset.veyraWidgetLoaded = "true";

  const workspace = script.getAttribute("data-workspace") || "";
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (!uuidPattern.test(workspace)) {
    console.warn("Veyra AI: missing or invalid data-workspace value.");
    return;
  }

  const serviceOrigin = new URL(script.src, document.baseURI).origin;
  const styleHref = serviceOrigin + "/widget.css";
  if (!document.querySelector('link[data-veyra-widget-styles="true"]')) {
    const stylesheet = document.createElement("link");
    stylesheet.rel = "stylesheet";
    stylesheet.href = styleHref;
    stylesheet.dataset.veyraWidgetStyles = "true";
    (document.head || document.documentElement).appendChild(stylesheet);
  }

  const launcher = document.createElement("a");
  launcher.className = "veyra-ai-launcher";
  launcher.href = serviceOrigin + "/guest.html?workspace=" + encodeURIComponent(workspace);
  launcher.target = "_blank";
  launcher.rel = "noopener noreferrer";
  launcher.textContent = (script.getAttribute("data-label") || "Chat with us").slice(0, 40);
  launcher.setAttribute("aria-label", "Open hotel guest support in a new tab");
  launcher.setAttribute("data-veyra-widget", "true");
  (document.body || document.documentElement).appendChild(launcher);
})();
