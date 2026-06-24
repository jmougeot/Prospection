// Helpers partagés par toutes les pages
const $ = (s, root) => (root || document).querySelector(s);
const $$ = (s, root) => [...(root || document).querySelectorAll(s)];

async function api(url, opts) {
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

function esc(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
}

function renderNav(active) {
  const links = [["leads.html", "Prospection"], ["apercu.html", "Aperçu"]];
  document.body.insertAdjacentHTML(
    "afterbegin",
    `<nav><a class="brand" href="leads.html"><span class="logo">E</span>Enrichissement</a>` +
      links
        .map(([href, label]) => `<a href="${href}" class="${href === active ? "active" : ""}">${label}</a>`)
        .join("") +
      `</nav>`
  );
}

/** Pastille d'initiales pour un contact (avatar de table). */
function avatar(first, last) {
  const i = ((first || "").trim()[0] || "") + ((last || "").trim()[0] || "");
  return `<span class="avatar">${esc(i || "?")}</span>`;
}

/** Notification éphémère en bas de l'écran (feedback d'action sans bloquer). */
function notify(msg, ok = true) {
  const t = document.createElement("div");
  t.className = "toast" + (ok ? "" : " bad");
  t.textContent = msg;
  document.body.appendChild(t);
  requestAnimationFrame(() => t.classList.add("show"));
  setTimeout(() => { t.classList.remove("show"); setTimeout(() => t.remove(), 300); }, 4000);
}
