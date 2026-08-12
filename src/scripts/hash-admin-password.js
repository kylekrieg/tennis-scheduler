'use strict';
// Usage: node src/scripts/hash-admin-password.js "your-chosen-password"
// Prints a bcrypt hash to paste into .env as ADMIN_PASSWORD_HASH.
const bcrypt = require('bcryptjs');

const password = process.argv[2];
if (!password) {
  console.error('Usage: node src/scripts/hash-admin-password.js "your-chosen-password"');
  process.exit(1);
}

const hash = bcrypt.hashSync(password, 12);
console.log(hash);
