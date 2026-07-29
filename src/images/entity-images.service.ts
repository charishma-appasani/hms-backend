import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { ImageAccessService } from './image-access.service';
import { ImagesService, type UploadPolicy } from './images.service';
import { IMAGE_TARGETS, type ImageTarget } from './image-targets';

/**
 * The write side of entity pictures: authorize, hand out an upload policy, then record that the
 * upload happened. Three steps because the file never passes through the API —
 *
 *   1. `requestUpload` → a presigned POST the browser uses to put the file in S3 directly.
 *   2. `commit`        → stamps the entity's marker; only now does the picture become visible.
 *   3. `remove`        → deletes the object and clears the marker.
 *
 * An upload that is never committed leaves an orphan object at the entity's own key, which the
 * next upload overwrites — so the one-object-per-entity guarantee holds regardless.
 */
@Injectable()
export class EntityImagesService {
  private readonly logger = new Logger(EntityImagesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly images: ImagesService,
    private readonly access: ImageAccessService,
    private readonly audit: AuditService,
  ) {}

  async requestUpload(target: ImageTarget, id: string): Promise<UploadPolicy> {
    await this.access.assertCanWrite(target, id);
    await this.assertEntityExists(target, id);
    return this.images.createUploadPolicy(target, id);
  }

  /** Mark the picture live and return its fresh URL (the caller swaps it straight into the UI). */
  async commit(
    target: ImageTarget,
    id: string,
  ): Promise<{ url: string | null }> {
    await this.access.assertCanWrite(target, id);
    const now = new Date();
    await this.setMarker(target, id, now);
    this.logger.log(`Image committed: target=${target} id=${id}`);
    await this.audit.record({
      action: 'image.update',
      entityType: target,
      entityId: id,
      metadata: { visibility: IMAGE_TARGETS[target].visibility },
    });
    return { url: await this.images.urlFor(target, id, now) };
  }

  async remove(target: ImageTarget, id: string): Promise<void> {
    await this.access.assertCanWrite(target, id);
    // Clear the marker FIRST: if the S3 delete then fails, the picture is already invisible
    // everywhere, and the orphan object is overwritten by the next upload to the same key.
    await this.setMarker(target, id, null);
    await this.images.remove(target, id);
    this.logger.log(`Image removed: target=${target} id=${id}`);
    await this.audit.record({
      action: 'image.delete',
      entityType: target,
      entityId: id,
    });
  }

  /**
   * Set (or clear) the entity's "has a picture, as of when" marker. A single nullable timestamp
   * per entity is the whole persistence story: non-null means an object exists at the target's
   * fixed key, and the value is the cache version. No key column — the key comes from the id.
   */
  private async setMarker(
    target: ImageTarget,
    id: string,
    imageUpdatedAt: Date | null,
  ): Promise<void> {
    const where = { id };
    switch (target) {
      case 'org':
        await this.prisma.organization.update({
          where,
          data: { imageUpdatedAt },
        });
        return;
      case 'practice':
        await this.prisma.practice.update({ where, data: { imageUpdatedAt } });
        return;
      case 'medicine':
        await this.prisma.medicine.update({ where, data: { imageUpdatedAt } });
        return;
      case 'user':
        await this.prisma.appUser.update({ where, data: { imageUpdatedAt } });
        return;
      case 'patient-id-card':
        await this.prisma.patient.update({
          where,
          data: { idCardUpdatedAt: imageUpdatedAt },
        });
        return;
    }
  }

  /**
   * Guard against stamping a marker on a row that isn't there. `practice` and `patient-id-card`
   * are already proven to exist by their access checks, so only the rest are looked up.
   */
  private async assertEntityExists(
    target: ImageTarget,
    id: string,
  ): Promise<void> {
    const found = await (async () => {
      switch (target) {
        case 'org':
          return this.prisma.organization.findFirst({
            where: { id, deletedAt: null },
            select: { id: true },
          });
        case 'medicine':
          return this.prisma.medicine.findFirst({
            where: { id, deletedAt: null },
            select: { id: true },
          });
        case 'user':
          return this.prisma.appUser.findFirst({
            where: { id },
            select: { id: true },
          });
        default:
          return { id };
      }
    })();
    if (!found) throw new NotFoundException('Not found');
  }
}
