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
    var s = document.querySelector('input[name="start_time"]');
    var d = document.querySelector('input[name="duration"]');
    var c = document.querySelector('input[name="count"]');
    if (s) s.value = start;
    if (d) d.value = duration;
    if (c) c.value = count;
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
