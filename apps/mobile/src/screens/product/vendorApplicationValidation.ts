export type VendorApplicationForm = {
  storeName: string;
  description: string;
  logoUrl: string;
  bannerUrl: string;
  contactEmail: string;
  contactPhone: string;
  street: string;
  city: string;
  province: string;
  country: string;
  website: string;
  instagram: string;
  facebook: string;
};

type RequiredVendorApplicationFields = Pick<
  VendorApplicationForm,
  | 'storeName'
  | 'description'
  | 'contactEmail'
  | 'street'
  | 'city'
  | 'province'
  | 'country'
>;

const requiredVendorApplicationFields = [
  ['Store name', (form: RequiredVendorApplicationFields) => form.storeName],
  ['Description', (form: RequiredVendorApplicationFields) => form.description],
  ['Contact email', (form: RequiredVendorApplicationFields) => form.contactEmail],
  ['Street', (form: RequiredVendorApplicationFields) => form.street],
  ['City', (form: RequiredVendorApplicationFields) => form.city],
  ['Province', (form: RequiredVendorApplicationFields) => form.province],
  ['Country', (form: RequiredVendorApplicationFields) => form.country],
] as const;

export function getVendorApplicationValidationMessage(
  form: RequiredVendorApplicationFields,
): string | null {
  const missingFields = requiredVendorApplicationFields
    .filter(([, getValue]) => !getValue(form).trim())
    .map(([label]) => label);

  if (missingFields.length === 0) {
    return null;
  }

  return `Complete the required store details: ${missingFields.join(', ')}.`;
}
