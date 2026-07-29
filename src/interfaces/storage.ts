export interface StoredObject {
  key: string;
  size: number;
  contentType: string;
  metadata: Record<string, string>;
  createdAt: string;
}

export interface ObjectStorage {
  put(key: string, data: ReadableStream | ArrayBuffer, options?: { contentType?: string; metadata?: Record<string, string> }): Promise<void>;
  get(key: string): Promise<{ data: ReadableStream; contentType: string; size: number } | null>;
  delete(key: string): Promise<void>;
  createSignedUrl?(key: string, expiresInSeconds: number): Promise<string>;
  head(key: string): Promise<StoredObject | null>;
}
