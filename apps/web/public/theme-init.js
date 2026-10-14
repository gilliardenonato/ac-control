// Aplica o tema antes da pintura (arquivo externo por causa da CSP, sem inline script). Padrão: escuro, como o dashboard do homelab.
(function () { try { var t = localStorage.getItem("theme"); document.documentElement.classList.add(t === "light" ? "light" : "dark"); } catch (e) { document.documentElement.classList.add("dark"); } })();
