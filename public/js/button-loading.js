/**
 * Konfident Interview 2025 — Global Button Loading & Action Feedback System
 * Automatically attaches interactive loading spinners to all form submissions
 * and provides window.setButtonLoading() for async operations.
 */
(function () {
  'use strict';

  function attachButtonLoading(form) {
    if (!form || form.dataset.loadingAttached) return;
    form.dataset.loadingAttached = 'true';

    form.addEventListener('submit', function (e) {
      // If form failed HTML5 client validation, do not trigger loading
      if (form.checkValidity && !form.checkValidity()) return;

      // Find the submit button
      var submitBtn = form.querySelector('button[type="submit"]:not([data-no-loading]), button:not([type="button"]):not([data-no-loading]), input[type="submit"]:not([data-no-loading])');
      if (!submitBtn) return;

      // Avoid double triggering
      if (submitBtn.classList.contains('loading')) return;

      submitBtn.classList.add('loading');
      submitBtn.setAttribute('aria-busy', 'true');

      if (!submitBtn.querySelector('.btn-spinner')) {
        var spinner = document.createElement('span');
        spinner.className = 'btn-spinner';
        spinner.setAttribute('aria-hidden', 'true');
        submitBtn.insertBefore(spinner, submitBtn.firstChild);
      }
    });
  }

  window.setButtonLoading = function (btn, isLoading, customText) {
    if (!btn) return;
    if (isLoading) {
      if (btn.classList.contains('loading')) return;
      btn.classList.add('loading');
      btn.setAttribute('aria-busy', 'true');
      btn.dataset.prevHtml = btn.innerHTML;
      
      var spinner = document.createElement('span');
      spinner.className = 'btn-spinner';
      spinner.setAttribute('aria-hidden', 'true');

      if (customText) {
        btn.innerHTML = '';
        btn.appendChild(spinner);
        btn.appendChild(document.createTextNode(' ' + customText));
      } else {
        btn.insertBefore(spinner, btn.firstChild);
      }
      btn.disabled = true;
    } else {
      btn.classList.remove('loading');
      btn.removeAttribute('aria-busy');
      btn.disabled = false;
      if (btn.dataset.prevHtml) {
        btn.innerHTML = btn.dataset.prevHtml;
        delete btn.dataset.prevHtml;
      } else {
        var sp = btn.querySelector('.btn-spinner');
        if (sp) sp.remove();
      }
    }
  };

  // Attach to all forms immediately and upon DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
      document.querySelectorAll('form').forEach(attachButtonLoading);
    });
  } else {
    document.querySelectorAll('form').forEach(attachButtonLoading);
  }

  // MutationObserver for dynamic modal dialogs & inserted forms
  if (typeof window.MutationObserver === 'function') {
    var observer = new MutationObserver(function (mutations) {
      mutations.forEach(function (m) {
        Array.prototype.forEach.call(m.addedNodes, function (node) {
          if (node.nodeType === 1) {
            if (node.tagName === 'FORM') attachButtonLoading(node);
            else if (node.querySelectorAll) {
              node.querySelectorAll('form').forEach(attachButtonLoading);
            }
          }
        });
      });
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }
})();
