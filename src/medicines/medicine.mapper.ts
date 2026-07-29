import type { Medicine } from '../../generated/prisma/client';

/** The wire shape of a catalog row (shared by the org autocomplete and the platform console). */
export function toMedicineResponse(m: Medicine) {
  return {
    id: m.id,
    name: m.name,
    genericName: m.genericName,
    manufacturer: m.manufacturer,
    ingredients: m.ingredients,
    form: m.form,
    strength: m.strength,
    drugClass: m.drugClass,
  };
}

export type MedicineResponse = ReturnType<typeof toMedicineResponse>;
