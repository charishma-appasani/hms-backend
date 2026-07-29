import {
  BadRequestException,
  Controller,
  Delete,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { EntityImagesService } from './entity-images.service';
import { isImageTarget, type ImageTarget } from './image-targets';

/**
 * One picture per entity (docs/architecture/asset-storage.md). The file itself never touches the API —
 * `upload-url` returns a presigned POST the browser sends straight to S3, then `commit` records it.
 *
 * Authenticated for everyone (the global JwtAuthGuard); per-target authorization is
 * ImageAccessService, because the rules differ by entity — an org admin owns the org logo, a
 * platform curator owns medicine photos, and a person owns their own avatar.
 */
@Controller('images/:target/:id')
export class ImagesController {
  constructor(private readonly images: EntityImagesService) {}

  @Post('upload-url')
  uploadUrl(
    @Param('target') target: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.images.requestUpload(parseTarget(target), id);
  }

  /** Call after the S3 upload succeeds; returns the URL to show immediately. */
  @Post('commit')
  commit(
    @Param('target') target: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.images.commit(parseTarget(target), id);
  }

  @Delete()
  @HttpCode(204)
  remove(
    @Param('target') target: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    return this.images.remove(parseTarget(target), id);
  }
}

function parseTarget(value: string): ImageTarget {
  if (!isImageTarget(value)) {
    throw new BadRequestException(`Unknown image target '${value}'`);
  }
  return value;
}
