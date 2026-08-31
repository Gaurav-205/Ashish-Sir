const db = require('./src/db');
const slots = db.prepare('SELECT * FROM slots').all();
console.log(slots);
