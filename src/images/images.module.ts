import { Global, Module } from '@nestjs/common';
import { ImagesController } from './images.controller';
import { ImagesService } from './images.service';
import { ImageAccessService } from './image-access.service';
import { EntityImagesService } from './entity-images.service';

/**
 * Entity pictures (docs/architecture/asset-storage.md). Global because ImagesService is what turns a
 * stored marker into a URL, and nearly every feature module needs that when building its payloads
 * (org header, practice list, medicine catalog, staff, patients, patient portal).
 */
@Global()
@Module({
  controllers: [ImagesController],
  providers: [ImagesService, ImageAccessService, EntityImagesService],
  exports: [ImagesService],
})
export class ImagesModule {}
