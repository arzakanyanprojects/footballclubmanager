// QA only: adds an admin account to a COPY of the data, so tests can sign in without anyone's real password.
// node .claude/qa/add-admin.js <copied userData folder> <username> <password>
// Refuses to touch the real data folder (%APPDATA%\FC Manager).
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const [dir, username, password] = process.argv.slice(2);
if (!dir || !username || !password) throw new Error('usage: add-admin.js <copied userData folder> <username> <password>');
const real = path.resolve(process.env.APPDATA || '', 'FC Manager').toLowerCase();
if (path.resolve(dir).toLowerCase() === real) throw new Error('refusing to change the real data folder');

const db = new DatabaseSync(path.join(dir, 'data', 'fcmanager.db'));
const salt = crypto.randomBytes(16).toString('hex');
const hash = `scrypt$${salt}$${crypto.scryptSync(String(password), salt, 64).toString('hex')}`;
db.prepare('DELETE FROM users WHERE username = ?').run(username);
db.prepare("INSERT INTO users (username, full_name, password_hash, is_admin, rights, active) VALUES (?, ?, ?, 1, '{}', 1)").run(username, `QA ${username}`, hash);
db.close();
console.log(`admin «${username}» added to ${dir}`);
