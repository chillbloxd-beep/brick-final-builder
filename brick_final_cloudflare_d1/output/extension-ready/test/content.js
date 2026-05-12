let last = "";

function reportVisit() {
  const sig = `${location.href}|${document.title}`;
  if (sig === last) return;
  last = sig;
  chrome.runtime.sendMessage({
    type: "PAGE_VISIT",
    title: document.title || location.hostname || "",
    url: location.href
  }).catch(() => {});
}

chrome.runtime.onMessage.addListener(msg => {
  if (msg?.type === "SHOW_MESSAGE") showMessage(msg.text || "");
});

function showMessage(text) {
  let box = document.getElementById("brick-class-msg");
  if (!box) {
    box = document.createElement("div");
    box.id = "brick-class-msg";
    document.documentElement.appendChild(box);
  }
  box.innerHTML = `<b>Class Message</b><p></p><button>Close</button>`;
  box.querySelector("p").textContent = text;
  box.querySelector("button").onclick = () => box.remove();
}

reportVisit();
setInterval(reportVisit, 5000);
new MutationObserver(reportVisit).observe(document.documentElement, {
  subtree: true,
  childList: true,
  characterData: true
});
