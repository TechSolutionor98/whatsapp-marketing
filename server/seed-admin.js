// Create or reset the superadmin (owner) account from SUPERADMIN_* env vars.
// Usage: npm run seed:admin
import { MongoClient } from 'mongodb';
import { MONGODB_URI, MONGODB_DB } from './config.js';
import { hashPassword } from './auth.js';

const email = process.env.SUPERADMIN_EMAIL;
const password = process.env.SUPERADMIN_PASSWORD;
const name = process.env.SUPERADMIN_NAME;

if (!email || !password) {
  console.error('✗ Set SUPERADMIN_EMAIL and SUPERADMIN_PASSWORD in .env first.');
  process.exit(1);
}

const client = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 8000 });
try {
  await client.connect();
  const users = client.db(MONGODB_DB).collection('users');
  await users.createIndex({ email: 1 }, { unique: true });

  const addr = email.toLowerCase().trim();
  const existing = await users.findOne({ email: addr });
  const passwordHash = await hashPassword(password);

  if (existing) {
    await users.updateOne(
      { _id: existing._id },
      { $set: { passwordHash, role: 'owner', name: name || existing.name } }
    );
    console.log(`✓ Superadmin updated (password reset): ${addr}`);
  } else {
    await users.insertOne({
      name: name || addr.split('@')[0],
      email: addr,
      passwordHash,
      role: 'owner',
      createdAt: new Date().toISOString(),
      lastLoginAt: null,
    });
    console.log(`✓ Superadmin created: ${addr}`);
  }
} catch (e) {
  console.error('✗ Seed failed:', e.message);
  process.exit(1);
} finally {
  await client.close();
}
process.exit(0);
