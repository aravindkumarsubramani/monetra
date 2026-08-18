window.Monetra = window.Monetra || {};

(function () {
  function backdrop() { return document.getElementById('modalBackdrop'); }
  function root() { return document.getElementById('modalRoot'); }

  function open(html, onMount) {
    root().innerHTML = html;
    backdrop().classList.add('open');
    if (onMount) onMount(root());
  }

  function close() {
    backdrop().classList.remove('open');
    root().innerHTML = '';
  }

  document.addEventListener('DOMContentLoaded', () => {
    backdrop().addEventListener('click', (e) => {
      if (e.target === backdrop()) close();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') close();
    });
  });

  Monetra.modal = { open, close };
})();
