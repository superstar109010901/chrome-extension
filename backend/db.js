/**
 * MongoDB connection and database utilities
 */

const { MongoClient } = require('mongodb');

let client = null;
let db = null;

/**
 * Connect to MongoDB
 */
async function connectDB() {
  if (db) {
    return db;
  }

  const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017';
  const dbName = process.env.MONGODB_DB_NAME || 'match_ai_assistant';

  try {
    client = new MongoClient(mongoUri);
    await client.connect();
    db = client.db(dbName);
    console.log(`✅ Connected to MongoDB: ${dbName}`);
    return db;
  } catch (error) {
    console.error('❌ MongoDB connection error:', error);
    throw error;
  }
}

/**
 * Get database instance
 */
async function getDB() {
  if (!db) {
    await connectDB();
  }
  return db;
}

/**
 * Get settings collection
 */
async function getSettingsCollection() {
  const database = await getDB();
  return database.collection('settings');
}

/**
 * Get OpenAI keys collection
 * Stores a single document containing the OpenAI API key.
 */
async function getOpenAIKeysCollection() {
  const database = await getDB();
  return database.collection('openai_keys');
}

/**
 * Close MongoDB connection
 */
async function closeDB() {
  if (client) {
    await client.close();
    client = null;
    db = null;
    console.log('MongoDB connection closed');
  }
}

module.exports = {
  connectDB,
  getDB,
  getSettingsCollection,
  getOpenAIKeysCollection,
  closeDB
};
