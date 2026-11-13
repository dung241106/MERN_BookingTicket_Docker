import "./env.js";
import mongoose from "mongoose";

export default async function connectDB() {
  if (!process.env.MONGODB_URL) throw new Error("Missing MONGODB_URL in server/.env");
  // dbName also works with Atlas URIs that already contain a database/query string.
  await mongoose.connect(process.env.MONGODB_URL, {
    dbName: process.env.MONGODB_DB_NAME || "quickshow", serverSelectionTimeoutMS: 10000,
  });
  console.log("MongoDB connected");
}
