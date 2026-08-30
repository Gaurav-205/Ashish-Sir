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
    var loc = document.querySelector('input[name="location"]');
    var letters = 'abcdefghijklmnopqrstuvwxyz';
    var randLetters = function (n) {
      var s = '';
      for (var i = 0; i < n; i++) {
        s += letters.charAt(Math.floor(Math.random() * letters.length));
      }
      return s;
    };
    var code = randLetters(3) + '-' + randLetters(4) + '-' + randLetters(3);
    if (loc) loc.value = 'https://meet.google.com/' + code;
  };
})();
