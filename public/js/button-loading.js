/**
 * Konfident Interview 2025 — Global UI/UX Enhancement Engine
 * 1. Automatic loading spinners & action feedback on form submits
 * 2. Universal modal dialog handlers (backdrop dismissal, ESC key, focus trap)
 * 3. Dismissible flash alert banners
 */
(function () {
  'use strict';

  // ---- 1. Form Validation & Submit Button Loading ----
  function attachButtonLoading(form) {
    if (!form || form.dataset.loadingAttached) return;
    form.dataset.loadingAttached = 'true';

    // Real-time input error clearing
    form.querySelectorAll('input, select, textarea').forEach(function (input) {
      input.addEventListener('input', function () {
        if (input.validity && input.validity.valid) {
          input.classList.remove('is-invalid');
          var field = input.closest('.field');
          if (field) field.classList.remove('has-error');
          var errMsg = field ? field.querySelector('.field-error-msg') : null;
          if (errMsg) errMsg.remove();
        }
      });
    });

    form.addEventListener('submit', function (e) {
      // Password confirmation matching check
      var p1 = form.querySelector('input[name="next1"], input[name="newPassword"]');
      var p2 = form.querySelector('input[name="next2"], input[name="confirmPassword"]');
      if (p1 && p2 && p1.value && p2.value && p1.value !== p2.value) {
        e.preventDefault();
        p2.classList.add('is-invalid');
        var field = p2.closest('.field');
        if (field) {
          field.classList.add('has-error');
          var existing = field.querySelector('.field-error-msg');
          if (!existing) {
            var msg = document.createElement('div');
            msg.className = 'field-error-msg';
            msg.textContent = 'Passwords do not match.';
            field.appendChild(msg);
          }
        }
        p2.focus();
        return;
      }

      if (form.checkValidity && !form.checkValidity()) {
        e.preventDefault();
        var firstInvalid = form.querySelector(':invalid');
        if (firstInvalid) {
          firstInvalid.classList.add('is-invalid');
          var field = firstInvalid.closest('.field');
          if (field) field.classList.add('has-error');
          firstInvalid.focus();
        }
        return;
      }

      var submitBtn = form.querySelector('button[type="submit"]:not([data-no-loading]), button:not([type="button"]):not([data-no-loading]), input[type="submit"]:not([data-no-loading])');
      if (!submitBtn) return;

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
    } else {
      btn.classList.remove('loading');
      btn.removeAttribute('aria-busy');
      if (btn.dataset.prevHtml) {
        btn.innerHTML = btn.dataset.prevHtml;
        delete btn.dataset.prevHtml;
      } else {
        var sp = btn.querySelector('.btn-spinner');
        if (sp) sp.remove();
      }
    }
  };

  // ---- 2. Universal Modal Dialog Backdrop Dismissal ----
  function attachModalHandlers(dialog) {
    if (!dialog || dialog.dataset.modalHandlersAttached) return;
    dialog.dataset.modalHandlersAttached = 'true';

    dialog.addEventListener('click', function (e) {
      var rect = dialog.getBoundingClientRect();
      var inDialog = (
        rect.top <= e.clientY && e.clientY <= rect.top + rect.height &&
        rect.left <= e.clientX && e.clientX <= rect.left + rect.width
      );
      if (!inDialog && typeof dialog.close === 'function') {
        dialog.close();
      }
    });
  }

  // ---- 3. Dismissible Flash Banners ----
  function initFlashAlerts() {
    document.querySelectorAll('.flash').forEach(function (f) {
      if (f.dataset.dismissAttached) return;
      f.dataset.dismissAttached = 'true';

      var closeBtn = document.createElement('button');
      closeBtn.type = 'button';
      closeBtn.className = 'flash-close-btn';
      closeBtn.innerHTML = '&times;';
      closeBtn.setAttribute('aria-label', 'Dismiss message');
      closeBtn.addEventListener('click', function () {
        f.style.opacity = '0';
        f.style.transform = 'translateY(-6px)';
        setTimeout(function () { f.remove(); }, 180);
      });
      f.appendChild(closeBtn);
    });
  }

  // Initialize
  function initAll() {
    document.querySelectorAll('form').forEach(attachButtonLoading);
    document.querySelectorAll('dialog').forEach(attachModalHandlers);
    initFlashAlerts();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initAll);
  } else {
    initAll();
  }

  // MutationObserver for dynamic modals, flash banners, and forms
  if (typeof window.MutationObserver === 'function') {
    var observer = new MutationObserver(function (mutations) {
      mutations.forEach(function (m) {
        Array.prototype.forEach.call(m.addedNodes, function (node) {
          if (node.nodeType === 1) {
            if (node.tagName === 'FORM') attachButtonLoading(node);
            else if (node.tagName === 'DIALOG') attachModalHandlers(node);
            else if (node.classList && node.classList.contains('flash')) initFlashAlerts();
            else if (node.querySelectorAll) {
              node.querySelectorAll('form').forEach(attachButtonLoading);
              node.querySelectorAll('dialog').forEach(attachModalHandlers);
              node.querySelectorAll('.flash').forEach(initFlashAlerts);
            }
          }
        });
      });
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }
})();
