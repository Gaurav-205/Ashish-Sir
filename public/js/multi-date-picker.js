/**
 * Multi-Date Calendar Picker for Konfident Interview Slot Creation
 * Allows selecting multiple calendar dates to create slots across all chosen days.
 */
(function () {
  'use strict';

  function initMultiDatePicker(containerId, hiddenInputId, previewCallback) {
    var container = document.getElementById(containerId);
    var hiddenInput = document.getElementById(hiddenInputId);
    if (!container || !hiddenInput) return;

    var selectedDates = new Set();
    
    // Initial date default
    var initialDate = hiddenInput.value ? hiddenInput.value.split(',')[0].trim() : '';
    var baseDate = initialDate ? new Date(initialDate + 'T00:00:00Z') : new Date();
    var currentYear = baseDate.getUTCFullYear();
    var currentMonth = baseDate.getUTCMonth(); // 0-11

    if (hiddenInput.value) {
      hiddenInput.value.split(',').forEach(function (d) {
        var trimmed = d.trim();
        if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) selectedDates.add(trimmed);
      });
    } else {
      // Default to today or tomorrow
      var todayStr = new Date().toISOString().slice(0, 10);
      selectedDates.add(todayStr);
      syncInput();
    }

    var monthNames = [
      'January', 'February', 'March', 'April', 'May', 'June',
      'July', 'August', 'September', 'October', 'November', 'December'
    ];

    function fmtIso(year, month, day) {
      var m = String(month + 1).padStart(2, '0');
      var d = String(day).padStart(2, '0');
      return year + '-' + m + '-' + d;
    }

    function syncInput() {
      var arr = Array.from(selectedDates).sort();
      hiddenInput.value = arr.join(',');
      if (typeof previewCallback === 'function') {
        previewCallback(arr);
      }
    }

    function render() {
      container.innerHTML = '';

      var widget = document.createElement('div');
      widget.className = 'date-picker-widget';

      // Header
      var header = document.createElement('div');
      header.className = 'date-picker-header';
      header.innerHTML = 
        '<div style="display:flex;align-items:center;gap:8px">' +
          '<button type="button" class="date-picker-nav-btn prev-btn" aria-label="Previous Month">&larr;</button>' +
          '<h4 style="margin:0;font-size:13px;font-weight:700">' + monthNames[currentMonth] + ' ' + currentYear + '</h4>' +
          '<button type="button" class="date-picker-nav-btn next-btn" aria-label="Next Month">&rarr;</button>' +
        '</div>' +
        '<div style="display:flex;gap:4px;flex-wrap:wrap">' +
          '<button type="button" class="btn sm select-week-btn" style="font-size:10px;padding:2px 6px">This Week</button>' +
          '<button type="button" class="btn sm select-next-week-btn" style="font-size:10px;padding:2px 6px">Next Week</button>' +
          '<button type="button" class="btn sm clear-all-btn" style="font-size:10px;padding:2px 6px">Clear</button>' +
        '</div>';

      widget.appendChild(header);

      // Calendar Grid
      var grid = document.createElement('div');
      grid.className = 'calendar-grid';

      var daysOfWeek = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
      daysOfWeek.forEach(function (d) {
        var dEl = document.createElement('div');
        dEl.className = 'calendar-day-head';
        dEl.textContent = d;
        grid.appendChild(dEl);
      });

      var firstDay = new Date(Date.UTC(currentYear, currentMonth, 1)).getUTCDay();
      var daysInMonth = new Date(Date.UTC(currentYear, currentMonth + 1, 0)).getUTCDate();
      var todayIso = new Date().toISOString().slice(0, 10);

      // Leading blank days
      for (var i = 0; i < firstDay; i++) {
        var blank = document.createElement('div');
        blank.className = 'calendar-day-btn disabled';
        grid.appendChild(blank);
      }

      // Days of the month
      for (var day = 1; day <= daysInMonth; day++) {
        var iso = fmtIso(currentYear, currentMonth, day);
        var dayOfWeek = (firstDay + day - 1) % 7;
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'calendar-day-btn';
        if (dayOfWeek === 0 || dayOfWeek === 6) btn.classList.add('is-weekend');
        if (selectedDates.has(iso)) btn.classList.add('selected');
        btn.textContent = day;
        btn.setAttribute('data-date', iso);

        btn.addEventListener('click', (function (dIso) {
          return function () {
            if (selectedDates.has(dIso)) {
              selectedDates.delete(dIso);
            } else {
              selectedDates.add(dIso);
            }
            syncInput();
            render();
          };
        })(iso));

        grid.appendChild(btn);
      }

      widget.appendChild(grid);

      // Selected Chips Summary
      var chipsContainer = document.createElement('div');
      chipsContainer.className = 'selected-dates-chips';
      var arr = Array.from(selectedDates).sort();

      if (!arr.length) {
        var emptyNotice = document.createElement('div');
        emptyNotice.className = 'faint';
        emptyNotice.style.fontSize = '12px';
        emptyNotice.style.marginTop = '6px';
        emptyNotice.textContent = 'No dates selected. Click dates above to select.';
        chipsContainer.appendChild(emptyNotice);
      } else {
        arr.forEach(function (dIso) {
          var dt = new Date(dIso + 'T00:00:00Z');
          var chip = document.createElement('span');
          chip.className = 'selected-date-chip';
          var monthShort = monthNames[dt.getUTCMonth()].slice(0, 3);
          var dayNum = dt.getUTCDate();
          var dayName = daysOfWeek[dt.getUTCDay()];
          chip.innerHTML = dayName + ' ' + dayNum + ' ' + monthShort + ' <span class="chip-remove" title="Remove">&times;</span>';

          chip.querySelector('.chip-remove').addEventListener('click', function () {
            selectedDates.delete(dIso);
            syncInput();
            render();
          });

          chipsContainer.appendChild(chip);
        });
      }

      widget.appendChild(chipsContainer);
      container.appendChild(widget);

      // Wire up header buttons
      header.querySelector('.prev-btn').addEventListener('click', function () {
        currentMonth--;
        if (currentMonth < 0) {
          currentMonth = 11;
          currentYear--;
        }
        render();
      });

      header.querySelector('.next-btn').addEventListener('click', function () {
        currentMonth++;
        if (currentMonth > 11) {
          currentMonth = 0;
          currentYear++;
        }
        render();
      });

      header.querySelector('.select-week-btn').addEventListener('click', function () {
        selectCurrentWeek(0);
        syncInput();
        render();
      });

      header.querySelector('.select-next-week-btn').addEventListener('click', function () {
        selectCurrentWeek(7);
        syncInput();
        render();
      });

      header.querySelector('.clear-all-btn').addEventListener('click', function () {
        selectedDates.clear();
        syncInput();
        render();
      });
    }

    function selectCurrentWeek(offsetDays) {
      var now = new Date();
      now.setUTCDate(now.getUTCDate() + offsetDays);
      var day = now.getUTCDay();
      var diffToMon = (day === 0 ? -6 : 1 - day);
      var monday = new Date(now);
      monday.setUTCDate(now.getUTCDate() + diffToMon);

      for (var i = 0; i < 5; i++) { // Mon-Fri
        var cur = new Date(monday);
        cur.setUTCDate(monday.getUTCDate() + i);
        selectedDates.add(cur.toISOString().slice(0, 10));
      }
    }

    render();
    syncInput();

    return {
      getSelectedDates: function () {
        return Array.from(selectedDates).sort();
      },
      addDate: function (iso) {
        selectedDates.add(iso);
        syncInput();
        render();
      },
      clear: function () {
        selectedDates.clear();
        syncInput();
        render();
      }
    };
  }

  window.initMultiDatePicker = initMultiDatePicker;
})();
