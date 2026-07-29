import type { ObjectStorage, StoredObject } from '../../../interfaces/storage.js';

export class R2StorageAdapter implements ObjectStorage {
  constructor(private readonly bucket: R2Bucket) {}

  async put(
    key: string,
    data: ReadableStream | ArrayBuffer,
    options?: { contentType?: string; metadata?: Record<string, string> },
  ): Promise<void> {
    await this.bucket.put(key, data, {
      httpMetadata: options?.contentType ? { contentType: options.contentType } : undefined,
      customMetadata: options?.metadata,
    });
  }

  async get(key: string): Promise<{ data: ReadableStream; contentType: string; size: number } | null> {
    const obj = await this.bucket.get(key);
    if (!obj) return null;
    return {
      data: obj.body,
      contentType: obj.httpMetadata?.contentType ?? 'application/octet-stream',
      size: obj.size,
    };
  }

  async delete(key: string): Promise<void> {
    await this.bucket.delete(key);
  }

  async head(key: string): Promise<StoredObject | null> {
    const obj = await this.bucket.head(key);
    if (!obj) return null;
    return {
      key: obj.key,
      size: obj.size,
      contentType: obj.httpMetadata?.contentType ?? 'application/octet-stream',
      metadata: obj.customMetadata ?? {},
      createdAt: obj.uploaded.toISOString(),
    };
  }
}
