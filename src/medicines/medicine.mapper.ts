import type { Medicine } from '../../generated/prisma/client';
import type { ImagesService } from '../images/images.service';

/**
 * The wire shape of a catalog row (shared by the org autocomplete and the platform console).
 * `imageUrl` is the pack photo's CDN URL, or null when the row has none.
 */
export async function toMedicineResponse(m: Medicine, images: ImagesService) {
  return {
    id: m.id,
    name: m.name,
    genericName: m.genericName,
    manufacturer: m.manufacturer,
    ingredients: m.ingredients,
    form: m.form,
    strength: m.strength,
    drugClass: m.drugClass,
    imageUrl: await images.urlFor('medicine', m.id, m.imageUpdatedAt),
  };
}

export function toMedicineResponses(rows: Medicine[], images: ImagesService) {
  return Promise.all(rows.map((m) => toMedicineResponse(m, images)));
}

export type MedicineResponse = Awaited<ReturnType<typeof toMedicineResponse>>;
