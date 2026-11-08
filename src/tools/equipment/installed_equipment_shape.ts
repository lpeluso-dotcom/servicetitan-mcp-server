export interface RawInstalledEquipment {
  id: number;
  name?: string;
  locationId?: number;
  customerId?: number;
  manufacturer?: string | null;
  model?: string | null;
  serialNumber?: string | null;
  installedOn?: string | null;
  manufacturerWarrantyEnd?: string | null;
  serviceProviderWarrantyEnd?: string | null;
  active?: boolean;
  modifiedOn?: string | null;
}

export interface SlimInstalledEquipment {
  id: number;
  name: string;
  location_id: number | null;
  customer_id: number | null;
  manufacturer: string | null;
  model: string | null;
  serial_number: string | null;
  installed_on: string | null;
  manufacturer_warranty_end: string | null;
  service_provider_warranty_end: string | null;
  active: boolean | null;
  modified_on: string | null;
}

export function slimInstalledEquipment(r: RawInstalledEquipment): SlimInstalledEquipment {
  return {
    id: r.id,
    name: r.name ?? '',
    location_id: r.locationId ?? null,
    customer_id: r.customerId ?? null,
    manufacturer: r.manufacturer ?? null,
    model: r.model ?? null,
    serial_number: r.serialNumber ?? null,
    installed_on: r.installedOn ?? null,
    manufacturer_warranty_end: r.manufacturerWarrantyEnd ?? null,
    service_provider_warranty_end: r.serviceProviderWarrantyEnd ?? null,
    active: r.active ?? null,
    modified_on: r.modifiedOn ?? null,
  };
}
