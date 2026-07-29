/**
 * The entities that can carry exactly ONE picture, and the rules for each.
 *
 * Every target maps to a FIXED S3 key derived from the entity id — no uuid, no timestamp, no file
 * extension. Re-uploading overwrites that key, so an entity can never accumulate a second object
 * and there is nothing to garbage-collect. The format is pinned to WebP (the browser re-encodes
 * before upload), which is what lets the key stay extensionless.
 *
 * `visibility` decides the bucket and how a URL is produced:
 *   cdn     → PUBLIC_ASSETS_BUCKET, served through CloudFront at a stable `?v=` URL.
 *   private → PRIVATE_IMAGES_BUCKET, served only via a short-lived presigned GET.
 * Personal imagery (people, ID documents) is `private`; branding and product imagery is `cdn`.
 */
export const IMAGE_TARGETS = {
  /** Organization logo — shown in the staff shell header and on printed prescriptions. */
  org: {
    visibility: 'cdn',
    key: (id: string) => `org/${id}/logo`,
    maxDimension: 512,
    maxBytes: 1_000_000,
  },
  /** Practice (branch) photo — shown to patients when picking a branch. */
  practice: {
    visibility: 'cdn',
    key: (id: string) => `practice/${id}/photo`,
    maxDimension: 512,
    maxBytes: 1_000_000,
  },
  /** Medicine pack/strip photo — helps confirm the right brand at dispensing time. */
  medicine: {
    visibility: 'cdn',
    key: (id: string) => `medicine/${id}/photo`,
    maxDimension: 512,
    maxBytes: 1_000_000,
  },
  /** Profile photo for ANY person (staff, doctor, platform operator, patient) — one identity, one
   *  avatar. Keyed by `app_user.id`. */
  user: {
    visibility: 'private',
    key: (id: string) => `user/${id}/avatar`,
    maxDimension: 512,
    maxBytes: 1_000_000,
  },
  /**
   * Patient ID / insurance card scan, keyed by `patient.id`. Deliberately larger than the avatars:
   * a card downscaled to 512px is unreadable, which would defeat the point of storing it. 1600px
   * keeps printed text legible while still bounding the object size.
   */
  'patient-id-card': {
    visibility: 'private',
    key: (id: string) => `patient/${id}/id-card`,
    maxDimension: 1600,
    maxBytes: 3_000_000,
  },
} as const satisfies Record<string, ImageTargetSpec>;

export interface ImageTargetSpec {
  visibility: 'cdn' | 'private';
  key: (id: string) => string;
  /** Longest edge the browser must downscale to before uploading. */
  maxDimension: number;
  /** Hard ceiling enforced by the presigned POST policy — S3 itself rejects anything larger. */
  maxBytes: number;
}

export type ImageTarget = keyof typeof IMAGE_TARGETS;

export const IMAGE_TARGET_NAMES = Object.keys(IMAGE_TARGETS) as ImageTarget[];

/** Every upload is re-encoded to this by the browser, so one key can never hold two formats. */
export const IMAGE_CONTENT_TYPE = 'image/webp';

export function isImageTarget(value: string): value is ImageTarget {
  return value in IMAGE_TARGETS;
}
