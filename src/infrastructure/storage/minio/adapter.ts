import type { ObjectStorage, StoredObject } from '../../../interfaces/storage.js';

export interface MinIOConfig {
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  region?: string;
}

/**
 * MinIO adapter scaffold — implements ObjectStorage for self-hosted deployments.
 *
 * To activate: install @aws-sdk/client-s3 and replace the stub bodies below.
 * MinIO is S3-compatible so the AWS SDK works as-is against a MinIO endpoint.
 *
 * See docs/FUTURE-MIGRATION.md and docs/KNOWN-LIMITATIONS.md for details.
 */
export class MinIOStorageAdapter implements ObjectStorage {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(_config: MinIOConfig) {
    // TODO: initialise S3Client from @aws-sdk/client-s3
    // this.s3 = new S3Client({ endpoint: config.endpoint, credentials: { ... }, region: config.region ?? 'us-east-1' });
  }

  async put(key: string, _data: ReadableStream | ArrayBuffer, _options?: { contentType?: string; metadata?: Record<string, string> }): Promise<void> {
    throw new Error(`MinIOStorageAdapter.put("${key}") is not implemented. See docs/KNOWN-LIMITATIONS.md #5.`);
  }

  async get(key: string): Promise<{ data: ReadableStream; contentType: string; size: number } | null> {
    throw new Error(`MinIOStorageAdapter.get("${key}") is not implemented. See docs/KNOWN-LIMITATIONS.md #5.`);
  }

  async delete(key: string): Promise<void> {
    throw new Error(`MinIOStorageAdapter.delete("${key}") is not implemented. See docs/KNOWN-LIMITATIONS.md #5.`);
  }

  async head(key: string): Promise<StoredObject | null> {
    throw new Error(`MinIOStorageAdapter.head("${key}") is not implemented. See docs/KNOWN-LIMITATIONS.md #5.`);
  }
}
