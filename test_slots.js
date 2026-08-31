const db = require('./src/db');
const h = require('./src/helpers');
const slots = db.prepare(`SELECT s.*, m.name AS mentor_name, m.email AS mentor_email FROM slots s JOIN users m ON m.id = s.mentor_id WHERE s.type = 'technical' AND s.status = 'booked' AND m.active = 1 AND (s.slot_date || ' ' || s.start_time) > ?`).all(h.nowMinute());
console.log(slots);
