// Narrow collection contract both the real driver and test fakes satisfy.
// Real mongodb Collection objects are structurally assignable.
export interface Docs {
  [key: string]: unknown;
}

export interface Col {
  insertOne(doc: Docs): Promise<{ acknowledged: boolean }>;
  findOne(filter: Docs): Promise<Docs | null>;
  updateOne(filter: Docs, update: Docs, options?: { upsert?: boolean }): Promise<{ matchedCount: number }>;
  deleteOne(filter: Docs): Promise<{ deletedCount: number }>;
  createIndex(spec: Docs, options?: Docs): Promise<string>;
}
