'use strict';
const app = require('./src/app');
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n  Konfident Interview 2025 running at http://localhost:${PORT}\n`);
});
