import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  IMAGE_CONTENT_TYPE,
  IMAGE_TARGETS,
  type ImageTarget,
} from './image-targets';
import type { Env } from '../config/env.schema';

/** How long a browser has to complete an upload after asking for a policy. */
const UPLOAD_WINDOW_SECONDS = 300;
/** Lifetime of a presigned read URL for personal imagery. Short, because it is a bearer token. */
const READ_WINDOW_SECONDS = 3600;

/** What the browser needs to POST a file straight to S3. */
export interface UploadPolicy {
  url: string;
  fields: Record<string, string>;
  /** Echoed so the client resizes to exactly what the policy will accept. */
  maxDimension: number;
  maxBytes: number;
  contentType: string;
}

/**
 * S3 storage for entity images (docs/architecture/asset-storage.md). Owns the bucket wiring only —
 * WHO may upload what is {@link ImageAccessService}, and WHICH entities exist is
 * {@link IMAGE_TARGETS}.
 *
 * Uploads never pass through the API: the browser gets a presigned POST policy that pins the key,
 * the content type, and a maximum size, then uploads directly to S3. The API is told afterwards
 * ("commit"), which is what stamps the entity's `image_updated_at`.
 *
 * When IMAGES_ENABLED is false (the local/CI default) uploads raise 503 and every URL is null, so
 * nothing here needs AWS credentials to run the app.
 */
@Injectable()
export class ImagesService {
  private readonly logger = new Logger(ImagesService.name);
  private readonly client?: S3Client;
  private readonly publicBucket?: string;
  private readonly privateBucket?: string;
  private readonly cdnDomain?: string;

  readonly enabled: boolean;

  constructor(config: ConfigService<Env, true>) {
    this.enabled = config.get('IMAGES_ENABLED', { infer: true });
    if (!this.enabled) {
      this.logger.log(
        'Entity images disabled (IMAGES_ENABLED=false) — uploads will 503',
      );
      return;
    }
    this.publicBucket = config.getOrThrow('PUBLIC_ASSETS_BUCKET');
    this.privateBucket = config.getOrThrow('PRIVATE_IMAGES_BUCKET');
    this.cdnDomain = config.getOrThrow('PUBLIC_ASSETS_CDN_DOMAIN');
    this.client = new S3Client({ region: config.getOrThrow('AWS_REGION') });
  }

  /**
   * A one-shot policy for uploading this entity's picture. The conditions are the real
   * enforcement — S3 rejects a mismatched key, a non-WebP body, or an oversized file, so a
   * tampered client cannot write anywhere else or fill the bucket.
   */
  async createUploadPolicy(
    target: ImageTarget,
    id: string,
  ): Promise<UploadPolicy> {
    const spec = IMAGE_TARGETS[target];
    const key = spec.key(id);
    const post = await createPresignedPost(this.requireClient(), {
      Bucket: this.bucketFor(target),
      Key: key,
      Conditions: [
        ['eq', '$key', key],
        ['eq', '$Content-Type', IMAGE_CONTENT_TYPE],
        ['content-length-range', 1, spec.maxBytes],
      ],
      Fields: { 'Content-Type': IMAGE_CONTENT_TYPE },
      Expires: UPLOAD_WINDOW_SECONDS,
    });
    return {
      url: post.url,
      fields: post.fields,
      maxDimension: spec.maxDimension,
      maxBytes: spec.maxBytes,
      contentType: IMAGE_CONTENT_TYPE,
    };
  }

  /**
   * A displayable URL, or null when the entity has no picture (or images are off).
   * `updatedAt` is the entity's stored marker: it doubles as the CDN cache-buster, so a replaced
   * logo is visible immediately instead of after the CloudFront TTL.
   */
  async urlFor(
    target: ImageTarget,
    id: string,
    updatedAt: Date | null | undefined,
  ): Promise<string | null> {
    if (!updatedAt || !this.enabled) return null;
    const key = IMAGE_TARGETS[target].key(id);
    if (IMAGE_TARGETS[target].visibility === 'cdn') {
      return `https://${this.cdnDomain}/${key}?v=${updatedAt.getTime()}`;
    }
    return getSignedUrl(
      this.requireClient(),
      new GetObjectCommand({ Bucket: this.privateBucket, Key: key }),
      { expiresIn: READ_WINDOW_SECONDS },
    );
  }

  /** Drop the object. Missing keys are fine — S3 DELETE is idempotent. */
  async remove(target: ImageTarget, id: string): Promise<void> {
    if (!this.enabled) return;
    await this.requireClient().send(
      new DeleteObjectCommand({
        Bucket: this.bucketFor(target),
        Key: IMAGE_TARGETS[target].key(id),
      }),
    );
  }

  private bucketFor(target: ImageTarget): string {
    return IMAGE_TARGETS[target].visibility === 'cdn'
      ? this.publicBucket!
      : this.privateBucket!;
  }

  private requireClient(): S3Client {
    if (!this.client) {
      throw new ServiceUnavailableException(
        'Image storage is not configured on this environment',
      );
    }
    return this.client;
  }
}
