import { S3Client, CreateBucketCommand, HeadBucketCommand } from '@aws-sdk/client-s3';

export function bucketClient(env = process.env) {
  return new S3Client({
    endpoint: env.S3_ENDPOINT,
    region: env.AWS_REGION || 'us-east-1',
    forcePathStyle: true,
    credentials: {
      accessKeyId: env.AWS_ACCESS_KEY_ID,
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
    },
  });
}

export async function ensureBucket(env = process.env) {
  const client = bucketClient(env);
  const Bucket = env.FOGD_BUCKET;
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      try { await client.send(new HeadBucketCommand({ Bucket })); }
      catch (error) {
        if (error.$metadata?.httpStatusCode !== 404) throw error;
        await client.send(new CreateBucketCommand({ Bucket }));
      }
      return;
    } catch (error) {
      if (attempt === 59) throw error;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
}
