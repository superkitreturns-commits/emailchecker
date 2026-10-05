// Owner-only: create (or reset the password of) a login.
//   npm run add-user -- <email> <password> [name]
import { Auth } from '../lib/auth.js';
import { dataDir, initDataDir } from '../lib/paths.js';

const [email, password, ...nameParts] = process.argv.slice(2);
if (!email || !password) {
  console.error('Usage: npm run add-user -- <email> <password> [name]');
  process.exit(1);
}
// Writes must land in the same place the server reads from, volume included.
await initDataDir();
const auth = new Auth({ dataDir });
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
  console.log('');
  console.log('https://mailfinderpro.xyz/');
  console.log(email);
  console.log(password);
  process.exit(0);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
