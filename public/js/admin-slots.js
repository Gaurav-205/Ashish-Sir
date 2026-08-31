(function () {
  var t = document.getElementById('typeSel');
  var m = document.getElementById('mentorSel');
  if (!t || !m) return;

  function sync() {
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

  t.addEventListener('change', sync);
  sync();

  window.applyPreset = function (start, duration, count) {
    var s = document.getElementById('adm_start_time') || document.querySelector('input[name="start_time"]');
    var d = document.getElementById('adm_duration') || document.querySelector('input[name="duration"]');
    var c = document.getElementById('adm_count') || document.querySelector('input[name="count"]');
    if (s) s.value = start;
    if (d) d.value = duration;
    if (c) c.value = count;
    window.updateAdminPreview();
  };

  window.updateAdminPreview = function () {
    var repEl = document.getElementById('adm_repeat_days');
    var countEl = document.getElementById('adm_count');
    var prevEl = document.getElementById('adm_preview_text');
    var exEl = document.getElementById('adm_exclude_weekends');
    var dateEl = document.getElementById('adm_slot_date');
    if (!repEl || !countEl || !prevEl) return;

    var days = parseInt(repEl.value, 10) || 1;
    var count = parseInt(countEl.value, 10) || 1;
    var ex = exEl && exEl.checked;
    var startDate = dateEl ? dateEl.value : '';

    var actualDays = days;
    if (ex && startDate && days > 1) {
      var valid = 0;
      for (var i = 0; i < days; i++) {
        var dt = new Date(startDate + 'T00:00:00Z');
        dt.setUTCDate(dt.getUTCDate() + i);
        var day = dt.getUTCDay();
        if (day !== 0 && day !== 6) valid++;
      }
      actualDays = valid;
    }

    var total = count * actualDays;
    prevEl.textContent = '⚡ Generating: ' + count + ' slots/day × ' + actualDays + ' day(s) = ' + total + ' total slot(s)';
  };

  var modal = document.getElementById('createSlotModal');
  if (modal) {
    modal.addEventListener('click', function (e) {
      var rect = modal.getBoundingClientRect();
      var inDialog = (rect.top <= e.clientY && e.clientY <= rect.top + rect.height &&
        rect.left <= e.clientX && e.clientX <= rect.left + rect.width);
      if (!inDialog) modal.close();
    });
  }
})();
