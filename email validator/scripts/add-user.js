// Owner-only: create (or reset the password of) a login.
//   npm run add-user -- <email> <password> [name]
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Auth } from '../lib/auth.js';

const [email, password, ...nameParts] = process.argv.slice(2);
if (!email || !password) {
  console.error('Usage: npm run add-user -- <email> <password> [name]');
  process.exit(1);
}
const auth = new Auth({ dataDir: join(dirname(fileURLToPath(import.meta.url)), '..', 'data') });
await auth.init();
try {
  const existing = auth.findByEmail(email);
  if (existing) {
    await auth.setPassword(existing, password);
    console.log(`Password updated for ${existing.email}`);
  } else {
    const user = await auth.signup({ name: nameParts.join(' '), email, password });
    console.log(`Created ${user.email}`);
  }
  process.exit(0);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
