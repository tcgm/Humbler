// Librarian's "already in your collection" highlighting, for store, bundle
// and Choice pages in the Humble pane.
//
// Not tied to one page layout: it marks any heading, link or short text
// element whose own text matches a title you own. The comparison ignores
// case, punctuation and ™/®.
// Re-applied as the page changes (MutationObserver), and re-injected on navigation.

function ownedMarkerSource(normalizedTitles) {
  return `
(() => {
  const owned = new Set(${JSON.stringify(normalizedTitles)});
  const norm = (s) => String(s || "").toLowerCase().replace(/[™®©]/g, "").replace(/&amp;/g, "&").replace(/[^a-z0-9&]+/g, " ").trim();
  if (!document.getElementById("humbler-owned-style")) {
    const st = document.createElement("style");
    st.id = "humbler-owned-style";
    st.textContent = ".humbler-owned{color:limegreen !important;text-decoration:underline dotted limegreen}" +
      ".humbler-owned-card{box-shadow:inset 0 0 0 2px limegreen !important;border-radius:4px}";
    document.head.appendChild(st);
  }
  const ownText = (el) => Array.from(el.childNodes).filter((n) => n.nodeType === 3).map((n) => n.textContent).join(" ");
  const mark = () => {
    const els = document.querySelectorAll("h1,h2,h3,h4,h5,a,span,p,div[class*=title],div[class*=name]");
    for (const el of els) {
      if (el.dataset.humblerChecked) continue;
      el.dataset.humblerChecked = "1";
      const text = (el.children.length === 0 ? el.textContent : ownText(el)).trim();
      if (text.length < 2 || text.length > 140) continue;
      if (!owned.has(norm(text))) continue;
      el.classList.add("humbler-owned");
      el.title = "Humbler: already in your library";
      const card = el.closest("[class*=item],[class*=tile],[class*=entity],[class*=choice],[class*=card]");
      if (card && card !== document.body) card.classList.add("humbler-owned-card");
    }
  };
  mark();
  if (window.__humblerOwnedObserver) window.__humblerOwnedObserver.disconnect();
  let timer = null;
  window.__humblerOwnedObserver = new MutationObserver(() => { clearTimeout(timer); timer = setTimeout(mark, 400); });
  window.__humblerOwnedObserver.observe(document.body, { childList: true, subtree: true });
  return document.querySelectorAll(".humbler-owned").length;
})()
`;
}

module.exports = { ownedMarkerSource };
