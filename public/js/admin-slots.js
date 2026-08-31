(function () {
  'use strict';

  var t = document.getElementById('typeSel');
  var m = document.getElementById('mentorSel');

  function sync() {
    if (!t || !m) return;
    var v = t.value;
    var first = null;
    Array.prototype.forEach.call(m.options, function (o) {
      var match = o.dataset.type === v;
      o.hidden = !match;
      o.disabled = !match;
      if (match && !first) first = o;
    });
    if (first && (m.selectedOptions[0] || {}).hidden !== false) m.value = first.value;
  }

  if (t && m) {
    t.addEventListener('change', sync);
    sync();
  }

  window.updateAdminPreview = function () {
    var selInput = document.getElementById('adm_selected_dates');
    var countEl = document.getElementById('adm_count');
    var prevEl = document.getElementById('adm_preview_text');
    var durEl = document.getElementById('adm_duration');
    if (!prevEl) return;

    var count = countEl ? (parseInt(countEl.value, 10) || 1) : 1;
    var duration = durEl ? (parseInt(durEl.value, 10) || 30) : 30;
    var dates = selInput && selInput.value ? selInput.value.split(',').filter(Boolean) : [];
    var days = Math.max(dates.length, 1);
    var total = count * days;

    var timeEl = document.getElementById('adm_start_time');
    var timeVal = timeEl && timeEl.value ? timeEl.value : '09:00';
    var parts = timeVal.split(':').map(Number);
    var endM = (parts[0] || 0) * 60 + (parts[1] || 0) + duration;
    var endVal = String(Math.floor(endM / 60) % 24).padStart(2, '0') + ':' + String(endM % 60).padStart(2, '0');

    prevEl.textContent = '⚡ Generating 1 slot (' + timeVal + ' – ' + endVal + ', ' + duration + ' mins) across ' + days + ' selected day(s) = ' + total + ' total slot(s)';
  };

  // Initialize multi-date calendar picker
  if (typeof window.initMultiDatePicker === 'function' && document.getElementById('adm_date_picker_container')) {
    window.initMultiDatePicker('adm_date_picker_container', 'adm_selected_dates', function (dates) {
      var slotDateEl = document.getElementById('adm_slot_date');
      if (slotDateEl && dates.length > 0) {
        slotDateEl.value = dates[0];
      }
      window.updateAdminPreview();
    });
  }

  // Manage Slot Modal Logic
  window.openSlotManageModal = function (slot) {
    var modal = document.getElementById('manageSlotModal');
    if (!modal || !slot) return;

    var titleEl = document.getElementById('mng_title');
    if (titleEl) {
      titleEl.textContent = 'Manage Slot — ' + (slot.type === 'hr' ? 'HR' : 'Technical') + ' (' + slot.slot_date + ' ' + slot.start_time + ')';
    }

    // Allotment form
    var allotSec = document.getElementById('mng_allot_section');
    var allotForm = document.getElementById('mng_allot_form');
    if (allotSec && allotForm) {
      if (slot.status === 'open') {
        allotSec.style.display = 'block';
        allotForm.action = '/admin/slots/' + slot.id + '/allot';
      } else {
        allotSec.style.display = 'none';
      }
    }

    // Reschedule form
    var reschedSec = document.getElementById('mng_reschedule_section');
    var reschedForm = document.getElementById('mng_reschedule_form');
    if (reschedSec && reschedForm) {
      if (slot.status !== 'cancelled' && slot.interview_status !== 'completed') {
        reschedSec.style.display = 'block';
        reschedForm.action = '/admin/slots/' + slot.id + '/reschedule';

        var dInput = document.getElementById('mng_slot_date');
        var sInput = document.getElementById('mng_start_time');
        var eInput = document.getElementById('mng_end_time');
        var mInput = document.getElementById('mng_mentor_id');
        var modeInput = document.getElementById('mng_mode');

        if (dInput) dInput.value = slot.slot_date || '';
        if (sInput) sInput.value = slot.start_time || '';
        if (eInput) eInput.value = slot.end_time || '';
        if (mInput) mInput.value = slot.mentor_id || '';
        if (modeInput) modeInput.value = slot.mode || 'Online';
      } else {
        reschedSec.style.display = 'none';
      }
    }

    // Actions
    var relForm = document.getElementById('mng_release_form');
    var canForm = document.getElementById('mng_cancel_form');
    var reopForm = document.getElementById('mng_reopen_form');

    if (relForm) {
      if (slot.status === 'booked' && slot.interview_status !== 'completed') {
        relForm.style.display = 'inline-block';
        relForm.action = '/admin/slots/' + slot.id + '/release';
      } else {
        relForm.style.display = 'none';
      }
    }

    if (canForm) {
      if (slot.status !== 'cancelled' && slot.interview_status !== 'completed') {
        canForm.style.display = 'inline-block';
        canForm.action = '/admin/slots/' + slot.id + '/cancel';
      } else {
        canForm.style.display = 'none';
      }
    }

    if (reopForm) {
      if (slot.status === 'cancelled') {
        reopForm.style.display = 'inline-block';
        reopForm.action = '/admin/slots/' + slot.id + '/reopen';
      } else {
        reopForm.style.display = 'none';
      }
    }

    var delForm = document.getElementById('mng_delete_form');

    if (delForm) {
      if (slot.interview_status !== 'completed') {
        delForm.style.display = 'inline-block';
        delForm.action = '/admin/slots/' + slot.id + '/delete';
      } else {
        delForm.style.display = 'none';
      }
    }

    modal.showModal();
  };

  // Close modals on backdrop click
  ['createSlotModal', 'manageSlotModal'].forEach(function (id) {
    var modal = document.getElementById(id);
    if (modal) {
      modal.addEventListener('click', function (e) {
        var rect = modal.getBoundingClientRect();
        var inDialog = (rect.top <= e.clientY && e.clientY <= rect.top + rect.height &&
          rect.left <= e.clientX && e.clientX <= rect.left + rect.width);
        if (!inDialog) modal.close();
      });
    }
  });
})();
