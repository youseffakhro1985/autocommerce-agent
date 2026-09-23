/**
 * Product-safety & policy gate (sections 5 & 6). Deterministic rules; "block on uncertainty".
 * This is a risk FILTER, not legal advice. It deliberately keeps the catalogue to simple, low-risk
 * goods at start (home, kitchen utensils, storage, garden hand tools, sports accessories without electronics…).
 */
export type ComplianceResult = 'PASS' | 'BLOCK' | 'REQUIRES_VERIFICATION';
export interface Finding { code: string; severity: 'BLOCK' | 'VERIFY' | 'INFO'; message: string }

export interface ComplianceInput {
  title: string;
  category?: string | null;
  brand?: string | null;
  description?: string | null;
  ean?: string | null;
  ceMarking?: string | null;              // YES | NO | NOT_REQUIRED | null
  gpsrManufacturer?: { name?: string; address?: string; email?: string; country?: string } | null;
  gpsrEuResponsible?: { name?: string; address?: string; email?: string } | null;
  safetyDocs?: unknown[] | null;
  imageRights: boolean;
  supplier: { status: string; isWholesaler: boolean; agreementSigned: boolean; blindDropship: boolean; companyVerified: boolean };
  authorizedBrands?: string[];            // brands owner is authorised to sell (Brand Registry / letters)
}

/** High-risk regulated groups: blocked outright at start. Keywords EN / SV / DE. */
const BLOCK_GROUPS: Record<string, RegExp> = {
  batteries: /\b(lithium|li-ion|lipo|battery|batteri|akku|power ?bank|rechargeable|uppladdningsbar)\b/i,
  electrical: /\b(230 ?v|220 ?v|mains|charger|laddare|ladegerät|adapter|plug|stickpropp|netzteil|usb[- ]c? charger|heater|värmare|electric|elektrisk|elektrisch|led strip|lamp|lampa)\b/i,
  children_toys: /\b(toy|toys|leksak|leksaker|spielzeug|baby|bebis|infant|toddler|kids|barn|kinder|children|child|pacifier|napp|stroller|barnvagn)\b/i,
  cosmetics: /\b(cosmetic|kosmetik|skin ?care|hudvård|serum|cream|kräm|lotion|makeup|smink|shampoo|perfume|parfym|nail polish)\b/i,
  pharma_supplements: /\b(supplement|kosttillskott|vitamin|capsule|kapsel|tablet|tablett|cbd|melatonin|protein powder|drug|läkemedel|medicine|arznei)\b/i,
  medical: /\b(medical|medicinsk|medizinisch|thermometer|termometer|blood pressure|blodtryck|oximeter|hearing aid|hörapparat|massage gun|tens)\b/i,
  food_contact_food: /\b(food|livsmedel|lebensmittel|snack|tea|te\b|coffee|kaffe|candy|godis|spice|krydd)\b/i,
  chemicals: /\b(chemical|kemikalie|aerosol|spray|glue|lim|kleber|solvent|pesticide|insecticide|bleach|cleaner|rengöring|paint|färg)\b/i,
  weapons: /\b(knife|kniv|messer|blade|dagger|pepper spray|airsoft|crossbow|armbrust|taser|stun|laser pointer|lasers?)\b/i,
  vape_tobacco: /\b(vape|e-cig|e-cigarette|snus|tobacco|tobak|nicotine|nikotin|hookah)\b/i,
  counterfeit: /\b(replica|kopia|inspired by|dupe|fake|1:1|oem logo)\b/i,
  pressure_pyro: /\b(firework|fyrverkeri|gas canister|butane|propane|co2 cartridge)\b/i,
};

/** Frequently gated / heavily enforced brands — selling requires authorisation. Not exhaustive. */
const GATED_BRANDS = /\b(apple|samsung|sony|nike|adidas|disney|marvel|pok[eé]mon|lego|nintendo|playstation|xbox|dyson|bosch|philips|lg|canon|nikon|gopro|stanley|yeti|north face|puma|rolex|gucci|louis vuitton|chanel|iphone|airpods|star wars|harry potter|barbie|hello kitty|paw patrol|minecraft)\b/i;

const GENERIC_BRANDS = /^(generic|unbranded|no brand|none|ohne marke|utan märke)$/i;

function validGtin(code: string): boolean {
  if (!/^\d{8}$|^\d{12,14}$/.test(code)) return false;
  const digits = code.split('').map(Number);
  const check = digits.pop()!;
  const sum = digits.reverse().reduce((s, d, i) => s + d * (i % 2 === 0 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === check;
}

export function checkCompliance(i: ComplianceInput): { result: ComplianceResult; riskLevel: 'LOW' | 'MEDIUM' | 'HIGH'; findings: Finding[] } {
  const f: Finding[] = [];
  const text = [i.title, i.category, i.description].filter(Boolean).join(' \n ');

  for (const [group, re] of Object.entries(BLOCK_GROUPS)) {
    const m = text.match(re);
    if (m) f.push({ code: `REGULATED_${group.toUpperCase()}`, severity: 'BLOCK', message: `High-risk regulated group "${group}" (matched "${m[0]}") — excluded at start` });
  }

  // Supplier legitimacy (Amazon/eBay dropshipping policies)
  if (!i.supplier.isWholesaler) f.push({ code: 'SUPPLIER_IS_RETAILER', severity: 'BLOCK', message: 'Supplier is a retailer/marketplace — retail-arbitrage dropshipping is prohibited on eBay and Amazon' });
  if (!i.supplier.blindDropship) f.push({ code: 'NO_BLIND_DROPSHIP', severity: 'BLOCK', message: 'Supplier cannot guarantee neutral packaging/documents — Amazon requires you as seller of record on slips/invoices/packaging' });
  if (i.supplier.status !== 'VERIFIED') f.push({ code: 'SUPPLIER_NOT_VERIFIED', severity: 'VERIFY', message: `Supplier status ${i.supplier.status}` });
  if (!i.supplier.agreementSigned) f.push({ code: 'NO_DROPSHIP_AGREEMENT', severity: 'VERIFY', message: 'No confirmed dropshipping/reseller agreement with supplier' });
  if (!i.supplier.companyVerified) f.push({ code: 'SUPPLIER_COMPANY_UNVERIFIED', severity: 'VERIFY', message: 'Supplier company details (VAT/registration) not verified' });

  // Brand / IP
  const brand = (i.brand ?? '').trim();
  const authorized = (i.authorizedBrands ?? []).map((b) => b.toLowerCase());
  const gated = text.match(GATED_BRANDS) || (brand && brand.match(GATED_BRANDS));
  if (gated && !authorized.includes(String(gated[0]).toLowerCase())) {
    f.push({ code: 'IP_GATED_BRAND', severity: 'BLOCK', message: `Mentions protected brand "${gated[0]}" without authorisation (trademark/IP risk)` });
  } else if (brand && !GENERIC_BRANDS.test(brand) && !authorized.includes(brand.toLowerCase())) {
    f.push({ code: 'BRAND_AUTH_UNKNOWN', severity: 'VERIFY', message: `Brand "${brand}" — authorisation to resell not confirmed (supplier letter or brand ownership)` });
  }

  // Identifiers
  if (!i.ean) f.push({ code: 'NO_GTIN', severity: 'VERIFY', message: 'Missing EAN/GTIN' });
  else if (!validGtin(i.ean)) f.push({ code: 'INVALID_GTIN', severity: 'VERIFY', message: `EAN/GTIN ${i.ean} fails checksum` });

  // GPSR (Regulation (EU) 2023/988): manufacturer identity + contact; EU responsible person if manufacturer outside EU
  const mfr = i.gpsrManufacturer;
  if (!mfr?.name || !mfr?.address || !mfr?.email) {
    f.push({ code: 'GPSR_MANUFACTURER_MISSING', severity: 'VERIFY', message: 'GPSR manufacturer name/postal address/electronic contact incomplete' });
  }
  const EU = /^(AT|BE|BG|HR|CY|CZ|DK|EE|FI|FR|DE|GR|HU|IE|IT|LV|LT|LU|MT|NL|PL|PT|RO|SK|SI|ES|SE)$/i;
  if (mfr?.country && !EU.test(mfr.country)) {
    const rp = i.gpsrEuResponsible;
    if (!rp?.name || !rp?.address || !rp?.email) f.push({ code: 'GPSR_EU_RP_MISSING', severity: 'VERIFY', message: `Manufacturer in ${mfr.country}: EU Responsible Person required` });
  }
  if (!i.safetyDocs || i.safetyDocs.length === 0) f.push({ code: 'NO_SAFETY_DOCS', severity: 'VERIFY', message: 'No safety information / warnings / instructions document from supplier' });
  if (i.ceMarking === 'NO') f.push({ code: 'CE_MISSING', severity: 'BLOCK', message: 'Supplier states product lacks CE marking' });
  if (i.ceMarking == null) f.push({ code: 'CE_UNKNOWN', severity: 'VERIFY', message: 'CE applicability not stated by supplier' });

  if (!i.imageRights) f.push({ code: 'IMAGE_RIGHTS', severity: 'VERIFY', message: 'No confirmed right to use supplier images' });

  const hasBlock = f.some((x) => x.severity === 'BLOCK');
  const hasVerify = f.some((x) => x.severity === 'VERIFY');
  return {
    result: hasBlock ? 'BLOCK' : hasVerify ? 'REQUIRES_VERIFICATION' : 'PASS',
    riskLevel: hasBlock ? 'HIGH' : hasVerify ? 'MEDIUM' : 'LOW',
    findings: f,
  };
}

export { validGtin };
