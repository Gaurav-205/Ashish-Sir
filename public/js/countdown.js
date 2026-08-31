(function () {
  'use strict';

  function tick() {
    var badges = document.querySelectorAll('.countdown-badge[data-start]');
    if (!badges.length) return;
    var now = new Date().getTime();

    badges.forEach(function (badge) {
      var startStr = badge.getAttribute('data-start');
      var endStr = badge.getAttribute('data-end');
      var labelEl = badge.querySelector('.countdown-label');
      if (!startStr || !labelEl) return;

      var startTime = new Date(startStr).getTime();
      var endTime = endStr ? new Date(endStr).getTime() : (startTime + 30 * 60 * 1000);

      if (now < startTime) {
        var diff = startTime - now;
        var days = Math.floor(diff / (1000 * 60 * 60 * 24));
        var hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
        var mins = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
        var secs = Math.floor((diff % (1000 * 60)) / 1000);

        badge.classList.remove('live');
        if (days > 0) {
          labelEl.textContent = '⏳ Starts in: ' + days + 'd ' + hours + 'h ' + mins + 'm ' + secs + 's';
        } else if (hours > 0) {
          labelEl.textContent = '⏳ Starts in: ' + hours + 'h ' + mins + 'm ' + secs + 's';
        } else if (mins > 0) {
          labelEl.textContent = '⏳ Starts in: ' + mins + 'm ' + secs + 's';
        } else {
          labelEl.textContent = '⏳ Starting in: ' + secs + 's';
        }
      } else if (now >= startTime && now <= endTime) {
        var left = endTime - now;
        var leftMins = Math.floor(left / (1000 * 60));
        var leftSecs = Math.floor((left % (1000 * 60)) / 1000);
        badge.classList.add('live');
        labelEl.textContent = '🔴 LIVE SESSION · ' + leftMins + 'm ' + leftSecs + 's remaining';
      } else {
        badge.classList.remove('live');
        labelEl.textContent = 'Slot Passed';
      }
    });
  }

  setInterval(tick, 1000);
  tick();
})();
