/**
 * Shared v2 shell behavior: Escape + tap-outside to close mobile nav drawers.
 * Safe on pages without purchasing shell or employee hub (no-ops).
 */
(function () {
  function closePurchasingNav() {
    document.body.classList.remove("ps-nav-open");
  }

  function closeEmployeeHubNav() {
    document.body.classList.remove("nav-open");
  }

  document.addEventListener("keydown", e => {
    if (e.key === "Escape") {
      closePurchasingNav();
      closeEmployeeHubNav();
    }
  });

  document.addEventListener(
    "click",
    e => {
      const t = e.target;
      if (!(t instanceof Node)) return;

      if (document.body.classList.contains("ps-nav-open")) {
        const sidebar = document.getElementById("psSidebar");
        const btn = document.getElementById("psMobileMenuBtn");
        if (sidebar && !sidebar.contains(t) && (!btn || !btn.contains(t))) {
          closePurchasingNav();
        }
      }

      if (document.body.classList.contains("nav-open")) {
        const sidebar = document.querySelector(".app .sidebar");
        const btn = document.getElementById("mobileMenuBtn");
        if (sidebar && !sidebar.contains(t) && (!btn || !btn.contains(t))) {
          closeEmployeeHubNav();
        }
      }
    },
    true
  );
})();
