import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

export interface ArtifactStoreConfig {
  endpoint?: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  prefix: string;
}

export interface ArtifactStore {
  readonly prefix: string;
  put(hash: string, bytes: Uint8Array, sidecar: string): Promise<void>;
  exists(hash: string): Promise<boolean>;
  get(hash: string): Promise<Uint8Array>;
}

export function artifactPrefix(env: NodeJS.ProcessEnv = process.env): string {
  return (env.ARTIFACT_PREFIX || "artifacts").replace(/^\/+|\/+$/g, "");
}

/** Build the artifact store from the shared S3 env. Returns null when unset. */
export function createArtifactStore(env: NodeJS.ProcessEnv = process.env): ArtifactStore | null {
  const bucket = env.S3_BUCKET;
  const accessKeyId = env.S3_ACCESS_KEY_ID;
  const secretAccessKey = env.S3_SECRET_ACCESS_KEY;
  if (!bucket || !accessKeyId || !secretAccessKey) return null;

  const client = new S3Client({
    region: env.S3_REGION ?? "auto",
    endpoint: env.S3_ENDPOINT,
    forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey },
  });
  const prefix = artifactPrefix(env);
  const key = (hash: string, extension: "bin" | "json") => `${prefix}/${hash}.${extension}`;

  return {
    prefix,
    async put(hash, bytes, sidecar) {
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key(hash, "bin"),
          Body: bytes,
          ContentType: "application/octet-stream",
        }),
      );
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key(hash, "json"),
          Body: sidecar,
          ContentType: "application/json",
        }),
      );
    },
    async exists(hash) {
      try {
        await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key(hash, "bin") }));
        return true;
      } catch (err) {
        const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata
          ?.httpStatusCode;
        if (status === 404) return false;
        throw err;
      }
    },
    async get(hash) {
      const out = await client.send(
        new GetObjectCommand({ Bucket: bucket, Key: key(hash, "bin") }),
      );
      const body = out.Body as { transformToByteArray?: () => Promise<Uint8Array> } | undefined;
      if (!body?.transformToByteArray) throw new Error("S3 GetObject returned no body");
      return body.transformToByteArray();
    },
  };
}
