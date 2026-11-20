require('dotenv').config();
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');

async function main() {
  const name = String(process.env.ADMIN_NAME || '').trim();
  const email = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  const password = String(process.env.ADMIN_PASSWORD || '');
  if (name.length < 2) throw new Error('Set ADMIN_NAME to the administrator name.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Set ADMIN_EMAIL to a valid email address.');
  if (password.length < 12) throw new Error('Set ADMIN_PASSWORD to at least 12 characters.');

  const connection = await mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'quizarena'
  });
  try {
    const [existing] = await connection.query('SELECT id FROM users WHERE email=?', [email]);
    if (existing.length) throw new Error('That email is already in use. Choose a new admin email.');
    const passwordHash = await bcrypt.hash(password, 12);
    await connection.query(
      'INSERT INTO users (name,email,password_hash,role) VALUES (?,?,?,\'admin\')',
      [name, email, passwordHash]
    );
    console.log(`Administrator account created for ${email}.`);
  } finally {
    await connection.end();
  }
}

main().catch(error => {
  console.error(error.message);
  process.exit(1);
});
