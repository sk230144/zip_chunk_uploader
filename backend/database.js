import { MongoClient } from 'mongodb';
import dotenv from 'dotenv';

dotenv.config();

const MONGO_URI = process.env.MONGO_URI || 'mongodb://root:rootpassword@localhost:27017/file_uploader?authSource=admin';

let client;
let db;

export async function connectDatabase() {
  if (db) return db;

  client = new MongoClient(MONGO_URI);
  await client.connect();

  db = client.db();

  await db.collection('uploads').createIndex({ id: 1 }, { unique: true });
  await db.collection('uploads').createIndex({ status: 1 });
  await db.collection('uploads').createIndex({ created_at: 1 });

  await db.collection('chunks').createIndex({ upload_id: 1, chunk_index: 1 }, { unique: true });
  await db.collection('chunks').createIndex({ upload_id: 1, status: 1 });

  console.log('Connected to MongoDB');
  return db;
}

export function getDatabase() {
  if (!db) {
    throw new Error('Database not initialized. Call connectDatabase() first.');
  }
  return db;
}

export async function closeDatabase() {
  if (client) {
    await client.close();
    client = null;
    db = null;
  }
}

export default { connectDatabase, getDatabase, closeDatabase };
