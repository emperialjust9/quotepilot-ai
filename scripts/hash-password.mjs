// QuotePilot — hash an operator password for QP_USERS_JSON.
//
// Uses hashPassword() from src/lib/auth.mjs — the exact scrypt approach the
// server verifies against (scrypt, 16-byte random salt, 64-byte derived key,
// stored as "<salt-hex>:<hash-hex>", the format configFromEnv validates).
//
// Usage:
//   node scripts/hash-password.mjs '<password>'
//   echo -n '<password>' | node scripts/hash-password.mjs
//
// The password is never echoed. Only the salt:hash string is printed.
// Passwords must be at least 12 characters (enforced by the library).
import { readFileSync } from 'node:fs';
import { hashPassword } from '../src/lib/auth.mjs';

let password = process.argv[2];
if (password === undefined) {
  password = readFileSync(0, 'utf8').replace(/\r?\n$/, '');
}
try {
  process.stdout.write(hashPassword(password) + '\n');
} catch (err) {
  console.error(`hash-password: ${err.message}`);
  process.exit(1);
}
