/**
 * Live availability for the student slot picker.
 *
 * Keeps the rendered list in step with the database without a full page reload,
 * and — importantly — stops guessing when it can no longer trust the server:
 * an expired session or a failed request surfaces to the student instead of
 * leaving a stale list on screen that books nothing.
 */
(function () {
  var container = document.getElementById('slots-container');
  if (!container) return;

  var POLL_MS = 20000;
  var currentType = container.dataset.type || '';
  var csrfToken = container.dataset.csrf || '';
  var isAlreadyBooked = container.dataset.alreadyBooked === 'true';
  var isProfileComplete = container.dataset.profileComplete !== 'false';

  var statusEl = document.getElementById('last-updated-text');
  var badgeEl = document.getElementById('auto-fetch-badge');
  var banner = document.getElementById('smart-auto-banner');
  var autoText = document.getElementById('smart-auto-text');
  var autoSlotId = document.getElementById('smart-auto-slot-id');
  var autoBtn = document.getElementById('smart-auto-btn');
  var mentorSelect = document.getElementById('mentor-select');

  var timer = null;
  var inFlight = false;
  var typeLabel = currentType === 'hr' ? 'HR' : 'Technical';

  function escHtml(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function setStatus(text, isError) {
    if (statusEl) statusEl.textContent = text;
    if (badgeEl) badgeEl.style.display = isError ? 'none' : '';
  }

  function stopPolling() {
    if (timer) { clearInterval(timer); timer = null; }
  }

  function renderSlots(byDate) {
    if (!byDate || !byDate.length) {
      container.innerHTML = '<div class="empty" id="empty-state" style="padding:48px 24px;text-align:center">' +
        '<svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="color:var(--slate);margin-bottom:12px">' +
        '<rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect><line x1="16" y1="2" x2="16" y2="6"></line><line x1="8" y1="2" x2="8" y2="6"></line><line x1="3" y1="10" x2="21" y2="10"></line></svg>' +
        '<div style="font-weight:600;font-size:15px;color:var(--ink);margin-bottom:4px">No open ' + escHtml(typeLabel) + ' slots scheduled right now</div>' +
        '<div class="faint" style="max-width:380px;margin:0 auto 16px">The system continuously auto-refreshes in the background and will immediately display new evaluator slots when published.</div>' +
        '<a class="btn sm" href="/student/mentors" style="display:inline-flex;align-items:center;gap:6px">Browse Mentors Directory &rarr;</a></div>';
      return;
    }
    var html = '';
    var canBook = !isAlreadyBooked && isProfileComplete;
    var btnText = !isProfileComplete ? 'Complete profile to book' : (isAlreadyBooked ? 'Already booked' : 'Book this slot →');

    byDate.forEach(function (g) {
      html += '<div class="slot-day" data-date="' + escHtml(g.date) + '">' +
              '<h3>' + escHtml(g.dateFormatted || g.date) + '</h3><div class="slot-list">';
      g.slots.forEach(function (sl) {
        html += '<div class="slot" id="slot-card-' + escHtml(sl.id) + '">' +
                '<div class="t">' + escHtml(sl.timeFormatted) + '</div>' +
                '<div class="m">Mentor: <strong>' + escHtml(sl.mentor_name) + '</strong><br>' +
                '<span class="faint">Mode: ' + escHtml(sl.mode) + '</span></div>' +
                '<form method="post" action="/student/book" style="margin:0">' +
                '<input type="hidden" name="_csrf" value="' + escHtml(csrfToken) + '">' +
                '<input type="hidden" name="slot_id" value="' + escHtml(sl.id) + '">' +
                '<input type="hidden" name="type" value="' + escHtml(currentType) + '">' +
                '<button class="btn primary sm" style="width:100%"' + (!canBook ? ' disabled' : '') + '>' +
                escHtml(btnText) + '</button>' +
                '</form></div>';
      });
      html += '</div></div>';
    });
    container.innerHTML = html;
  }

  function fetchLatestSlots() {
    if (inFlight || document.hidden) return;
    inFlight = true;

    var mentorId = mentorSelect ? mentorSelect.value : '';
    var url = '/student/api/slots/available?type=' + encodeURIComponent(currentType) +
              (mentorId ? '&mentor=' + encodeURIComponent(mentorId) : '');

    fetch(url, { headers: { Accept: 'application/json' }, credentials: 'same-origin' })
      .then(function (res) {
        // requireRole answers a non-HTML request with 401 rather than a redirect.
        if (res.status === 401 || res.status === 403) {
          stopPolling();
          setStatus('Your session expired — reloading…', true);
          window.location.reload();
          return null;
        }
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (data) {
        if (!data) return;
        setStatus('Synced ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), false);

        if (data.profileComplete !== undefined) {
          isProfileComplete = data.profileComplete !== false;
        }

        if (data.earliest && !isAlreadyBooked) {
          if (autoText) {
            autoText.innerHTML = '<strong>' + escHtml(data.earliest.slotFormatted) + '</strong> with <strong>' +
              escHtml(data.earliest.mentor_name) + '</strong> (' + escHtml(data.earliest.mode) + ')';
          }
          if (autoSlotId) autoSlotId.value = data.earliest.id;
          if (autoBtn) {
            autoBtn.disabled = !isProfileComplete || isAlreadyBooked;
            if (!isProfileComplete) autoBtn.textContent = 'Complete profile to book';
          }
          if (banner) banner.style.display = 'block';
        } else if (banner) {
          banner.style.display = 'none';
        }

        renderSlots(data.byDate);
      })
      .catch(function () {
        setStatus('Could not refresh — showing the last known list.', true);
      })
      .then(function () { inFlight = false; });
  }

  // Keep the chosen mentor in the URL so a refresh or a shared link keeps the filter.
  if (mentorSelect) {
    mentorSelect.addEventListener('change', function () {
      var url = new URL(window.location.href);
      url.searchParams.set('type', currentType);
      if (mentorSelect.value) url.searchParams.set('mentor', mentorSelect.value);
      else url.searchParams.delete('mentor');
      window.history.replaceState({}, '', url.toString());
      fetchLatestSlots();
    });
  }

  // Booking navigates away; stop refreshing so the list cannot be swapped
  // out from under a click that is already in flight.
  container.addEventListener('submit', stopPolling);
  var quickForm = document.getElementById('smart-auto-form');
  if (quickForm) quickForm.addEventListener('submit', stopPolling);
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) fetchLatestSlots();
  });
  window.addEventListener('pagehide', stopPolling);

  window.fetchLatestSlots = fetchLatestSlots;

  fetchLatestSlots();
  timer = setInterval(fetchLatestSlots, POLL_MS);
})();
