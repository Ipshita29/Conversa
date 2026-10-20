import mongoose from 'mongoose';
import { config } from './env.js';

let retryTimer = null;

export const isDbReady = () => mongoose.connection.readyState === 1;

// Connects without crashing the server: if MongoDB is unreachable, DB-backed routes answer 503 and we retry.
export async function connectDb(uri = config.mongoUri) {
  if (!uri) {
    console.warn('MONGODB_URI is not set: database-backed routes will respond 503 until it is configured.');
    return false;
  }
  try {
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 });
    console.log('MongoDB connected');
    return true;
  } catch (err) {
    console.error(`MongoDB connection failed (${err.name}). Retrying in 15s.`);
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => connectDb(uri), 15000);
    retryTimer.unref();
    return false;
  }
}
