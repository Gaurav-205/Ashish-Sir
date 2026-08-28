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

  window.autoGenLink = function () {
    var type = (t ? t.value : 'technical') || 'interview';
    var loc = document.querySelector('input[name="location"]');
    var id = Math.random().toString(36).substring(2, 8);
    var time = Date.now().toString(36);
    if (loc) loc.value = 'https://meet.jit.si/konfident-' + type + '-' + time + '-' + id;
  };
})();
