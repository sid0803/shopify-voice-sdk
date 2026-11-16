// Lazy Mongo client (senior item 3/4). Connection string and db name come
// from MONGODB_URI / MONGODB_DB only — never code.
import { MongoClient, type Db } from "mongodb";

let client: MongoClient | null = null;

export async function getDb(): Promise<Db> {
  if (!process.env["MONGODB_URI"]) throw new Error("MONGODB_URI is required");
  if (!client) {
    client = new MongoClient(process.env["MONGODB_URI"]);
    await client.connect();
  }
  const dbName = process.env["MONGODB_DB"];
  return dbName ? client.db(dbName) : client.db();
}

export async function closeMongo(): Promise<void> {
  if (client) {
    await client.close();
    client = null;
  }
}
