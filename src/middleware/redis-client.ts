import Redis from 'ioredis';

let _redis: Redis | null = null;
let _available = false;

export function getRedis(): Redis | null {
  return _available ? _redis : null;
}

export async function connectRedis(): Promise<void> {
  const url = process.env.REDIS_URL;
  if (!url) return;

  try {
    const client = new Redis(url, {
      lazyConnect: true,
      connectTimeout: 2000,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
    });
    await client.connect();
    _redis = client;
    _available = true;
    client.on('error', () => {
      _available = false;
    });
    client.on('reconnecting', () => {
      _available = false;
    });
    client.on('ready', () => {
      _available = true;
    });
  } catch {
    _available = false;
  }
}
