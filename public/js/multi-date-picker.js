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
    var baseDate = (initialDate && /^\d{4}-\d{2}-\d{2}$/.test(initialDate)) ? new Date(initialDate + 'T00:00:00Z') : new Date();
    var currentYear = baseDate.getUTCFullYear();
    var currentMonth = baseDate.getUTCMonth(); // 0-11

    if (hiddenInput.value) {
      hiddenInput.value.split(',').forEach(function (d) {
        var trimmed = d.trim();
        if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) selectedDates.add(trimmed);
      });
    }

    if (selectedDates.size === 0) {
      // Default to tomorrow or today
      var tomorrow = new Date();
      tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
      selectedDates.add(tomorrow.toISOString().slice(0, 10));
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
      widget.style.cssText = 'background:var(--surface, #ffffff);border:1px solid var(--line, #e2e8f0);border-radius:10px;padding:12px;margin:8px 0 12px;';

      // Header
      var header = document.createElement('div');
      header.className = 'date-picker-header';
      header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:10px;flex-wrap:wrap;';
      header.innerHTML = 
        '<div style="display:flex;align-items:center;gap:8px">' +
          '<button type="button" class="date-picker-nav-btn prev-btn" aria-label="Previous Month" style="background:var(--surface-alt, #f8fafc);border:1px solid var(--line, #cbd5e1);border-radius:4px;width:28px;height:28px;cursor:pointer;font-weight:700;display:flex;align-items:center;justify-content:center">&larr;</button>' +
          '<h4 style="margin:0;font-size:13px;font-weight:700;font-family:var(--font-display, inherit)">' + monthNames[currentMonth] + ' ' + currentYear + '</h4>' +
          '<button type="button" class="date-picker-nav-btn next-btn" aria-label="Next Month" style="background:var(--surface-alt, #f8fafc);border:1px solid var(--line, #cbd5e1);border-radius:4px;width:28px;height:28px;cursor:pointer;font-weight:700;display:flex;align-items:center;justify-content:center">&rarr;</button>' +
        '</div>' +
        '<div style="display:flex;gap:4px;flex-wrap:wrap">' +
          '<button type="button" class="btn sm select-week-btn" style="font-size:11px;padding:3px 8px;border-radius:12px">This Week</button>' +
          '<button type="button" class="btn sm select-next-week-btn" style="font-size:11px;padding:3px 8px;border-radius:12px">Next Week</button>' +
          '<button type="button" class="btn sm clear-all-btn" style="font-size:11px;padding:3px 8px;border-radius:12px">Clear</button>' +
        '</div>';

      widget.appendChild(header);

      // Calendar Grid
      var grid = document.createElement('div');
      grid.className = 'calendar-grid';
      grid.style.cssText = 'display:grid !important;grid-template-columns:repeat(7, 1fr) !important;gap:4px;margin-bottom:10px;';

      var daysOfWeek = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
      daysOfWeek.forEach(function (d) {
        var dEl = document.createElement('div');
        dEl.className = 'calendar-day-head';
        dEl.style.cssText = 'text-align:center;font-size:11px;font-weight:700;color:var(--slate, #64748b);padding:4px 0;text-transform:uppercase;';
        dEl.textContent = d;
        grid.appendChild(dEl);
      });

      var firstDay = new Date(Date.UTC(currentYear, currentMonth, 1)).getUTCDay();
      var daysInMonth = new Date(Date.UTC(currentYear, currentMonth + 1, 0)).getUTCDate();
      var todayIso = new Date(Date.now() + 5.5 * 3600000).toISOString().slice(0, 10);

      // Leading blank days
      for (var i = 0; i < firstDay; i++) {
        var blank = document.createElement('div');
        blank.className = 'calendar-day-btn disabled';
        blank.style.cssText = 'height:32px;visibility:hidden;pointer-events:none;';
        grid.appendChild(blank);
      }

      // Days of the month
      for (var day = 1; day <= daysInMonth; day++) {
        var iso = fmtIso(currentYear, currentMonth, day);
        var dayOfWeek = (firstDay + day - 1) % 7;
        var isPastDate = (iso < todayIso);
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'calendar-day-btn';
        var isSelected = selectedDates.has(iso);
        var isWeekend = (dayOfWeek === 0 || dayOfWeek === 6);

        if (isWeekend) btn.classList.add('is-weekend');
        if (isSelected) btn.classList.add('selected');
        if (isPastDate) btn.classList.add('is-past');

        var bg = isSelected ? '#17171c' : (isPastDate ? 'var(--surface-alt, #f8fafc)' : (isWeekend ? 'var(--surface-alt, #f8fafc)' : 'var(--surface, #ffffff)'));
        var color = isSelected ? '#ffffff' : (isPastDate ? '#cbd5e1' : (isWeekend ? 'var(--slate, #64748b)' : 'var(--ink, #1e293b)'));
        var border = isSelected ? '#17171c' : 'var(--line-soft, #e2e8f0)';
        var weight = isSelected ? '700' : '500';
        var cursor = isPastDate ? 'not-allowed' : 'pointer';

        btn.style.cssText = 'height:32px;border:1px solid ' + border + ';border-radius:6px;background:' + bg + ';color:' + color + ';cursor:' + cursor + ';font-size:12px;font-weight:' + weight + ';display:flex;align-items:center;justify-content:center;transition:all 0.12s ease;padding:0;';
        if (isPastDate) {
          btn.style.opacity = '0.4';
          btn.disabled = true;
        }
        btn.textContent = day;
        btn.setAttribute('data-date', iso);

        if (!isPastDate) {
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
        }

        grid.appendChild(btn);
      }

      widget.appendChild(grid);

      // Selected Chips Summary
      var chipsContainer = document.createElement('div');
      chipsContainer.className = 'selected-dates-chips';
      chipsContainer.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-top:8px;padding-top:8px;border-top:1px solid var(--line-soft, #e2e8f0);min-height:28px;';
      var arr = Array.from(selectedDates).sort();

      if (!arr.length) {
        var emptyNotice = document.createElement('div');
        emptyNotice.className = 'faint';
        emptyNotice.style.cssText = 'font-size:12px;color:var(--slate, #64748b);';
        emptyNotice.textContent = 'No dates selected. Click dates above to select.';
        chipsContainer.appendChild(emptyNotice);
      } else {
        arr.forEach(function (dIso) {
          var dt = new Date(dIso + 'T00:00:00Z');
          var chip = document.createElement('span');
          chip.className = 'selected-date-chip';
          chip.style.cssText = 'display:inline-flex;align-items:center;gap:6px;background:#eff6ff;color:#1d4ed8;border:1px solid #bfdbfe;border-radius:16px;padding:3px 10px;font-size:11px;font-weight:600;';
          var monthShort = monthNames[dt.getUTCMonth()].slice(0, 3);
          var dayNum = dt.getUTCDate();
          var dayName = daysOfWeek[dt.getUTCDay()];
          chip.innerHTML = dayName + ' ' + dayNum + ' ' + monthShort + ' <span class="chip-remove" title="Remove" style="cursor:pointer;font-weight:700;color:#ef4444;margin-left:2px">&times;</span>';

          chip.querySelector('.chip-remove').addEventListener('click', function (ev) {
            ev.stopPropagation();
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
        var curIso = cur.toISOString().slice(0, 10);
        if (curIso >= todayIso) {
          selectedDates.add(curIso);
        }
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
