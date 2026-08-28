(function () {
  const container = document.getElementById('slots-container');
  if (!container) return;

  const currentType = container.dataset.type || '';
  const csrfToken = container.dataset.csrf || '';
  const isAlreadyBooked = container.dataset.alreadyBooked === 'true';

  async function fetchLatestSlots() {
    const mentorSelect = document.getElementById('mentor-select');
    const mentorId = mentorSelect ? mentorSelect.value : '';
    const lastUpdated = document.getElementById('last-updated-text');
    const banner = document.getElementById('smart-auto-banner');
    const autoText = document.getElementById('smart-auto-text');
    const autoSlotId = document.getElementById('smart-auto-slot-id');

    try {
      const url = `/student/api/slots/available?type=${encodeURIComponent(currentType)}${mentorId ? '&mentor=' + encodeURIComponent(mentorId) : ''}`;
      const res = await fetch(url);
      if (!res.ok) return;
      const data = await res.json();

      const now = new Date();
      if (lastUpdated) {
        lastUpdated.textContent = 'Synced ' + now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      }

      // Handle Smart Match Banner
      if (data.earliest && !isAlreadyBooked) {
        if (autoText) autoText.innerHTML = `<strong>${data.earliest.slotFormatted}</strong> with <strong>${data.earliest.mentor_name}</strong> (${data.earliest.mode})`;
        if (autoSlotId) autoSlotId.value = data.earliest.id;
        if (banner) banner.style.display = 'block';
      } else {
        if (banner) banner.style.display = 'none';
      }

      // Render Slots
      if (!data.byDate || data.byDate.length === 0) {
        container.innerHTML = `<div class="empty">No open ${currentType.toUpperCase()} slots available currently. The system will auto-detect when new slots are published.</div>`;
        return;
      }

      let html = '';
      for (const g of data.byDate) {
        html += `
          <div class="slot-day" data-date="${g.date}">
            <h3>${g.dateFormatted || g.date}</h3>
            <div class="slot-list">`;
        for (const sl of g.slots) {
          html += `
            <div class="slot" id="slot-card-${sl.id}">
              <div class="t">${sl.timeFormatted}</div>
              <div class="m">Mentor: <strong>${sl.mentor_name}</strong><br>${sl.mode}${sl.locationFormatted ? ' · ' + sl.locationFormatted : ''}</div>
              <form method="post" action="/student/book" style="margin:0">
                <input type="hidden" name="_csrf" value="${csrfToken}">
                <input type="hidden" name="slot_id" value="${sl.id}">
                <input type="hidden" name="type" value="${currentType}">
                <button class="btn primary sm" style="width:100%" ${isAlreadyBooked ? 'disabled' : ''}>
                  ${isAlreadyBooked ? 'Already booked' : 'Book this slot →'}
                </button>
              </form>
            </div>`;
        }
        html += `
            </div>
          </div>`;
      }
      container.innerHTML = html;
    } catch (err) {
      console.warn('Auto-fetch error:', err);
    }
  }

  // Initial smart match run
  fetchLatestSlots();

  // Auto-fetch in background every 10 seconds
  setInterval(fetchLatestSlots, 10000);
})();
