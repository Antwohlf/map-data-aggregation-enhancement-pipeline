const category = (value) => String(value || '').toLowerCase();

export function normalizeAddress(address) {
  return String(address || '').toLowerCase().replace(/[.,#]/g, '')
    .replace(/\bstreet\b/g, 'st').replace(/\bavenue\b/g, 'ave').replace(/\bdrive\b/g, 'dr')
    .replace(/\bboulevard\b/g, 'blvd').replace(/\broad\b/g, 'rd').replace(/\blane\b/g, 'ln')
    .replace(/\bcourt\b/g, 'ct').replace(/\bplace\b/g, 'pl').replace(/\s+/g, ' ').trim();
}

export function createAddressHash(address) {
  let hash = 0;
  const normalized = normalizeAddress(address);
  for (let index = 0; index < normalized.length; index += 1) hash = ((hash << 5) - hash + normalized.charCodeAt(index)) | 0;
  return Math.abs(hash).toString(36);
}

export function categoryFromDetroit(proposedUseType, useGroup) {
  const use = category(proposedUseType); const group = category(useGroup);
  if (['single family','two family','multi-family','multifamily','residential','dwelling','apartment','condo','townhouse','duplex','triplex'].some(x => use.includes(x)) || ['r-1','r-2','r-3','r-4','r1','r2','r3','r4'].some(x => group.includes(x))) return 'HOUSING';
  if (['restaurant','food','cafe','coffee','bar','tavern','bakery','grocery','kitchen','catering','brewery','distillery'].some(x => use.includes(x))) return 'FOOD';
  if (['retail','store','shop','mercantile','sales','showroom','mall','boutique'].some(x => use.includes(x)) || group.includes('m')) return 'RETAIL';
  if (['office','business','professional','corporate','coworking'].some(x => use.includes(x)) || group.includes('b')) return 'OFFICE';
  if (['utility','industrial','warehouse','factory','assembly','storage','manufacturing','distribution','parking','garage','hospital','school','church','religious','government','municipal'].some(x => use.includes(x)) || ['f','s','h','i'].some(x => group.includes(x))) return 'INFRA';
  return 'OTHER';
}

export function categoryFromAnnArbor(type, classField) {
  const t = category(type); const c = category(classField);
  if (t.includes('site plan')) {
    if (['residential','apartment','housing','condo'].some(x => c.includes(x))) return 'HOUSING';
    if (['restaurant','food','cafe','bar'].some(x => c.includes(x))) return 'FOOD';
    if (['retail','commercial','store','shop'].some(x => c.includes(x))) return 'RETAIL';
    if (['office','business'].some(x => c.includes(x))) return 'OFFICE';
    return 'OTHER';
  }
  if (t.includes('rezoning') || t.includes('rezone')) {
    if (['residential','pud','r1','r2'].some(x => c.includes(x))) return 'HOUSING';
    if (['commercial','c1','c2'].some(x => c.includes(x))) return 'RETAIL';
    return 'OTHER';
  }
  if (t.includes('design review') || t.includes('zoning board') || t.includes('zba')) return 'OTHER';
  if (t.includes('annexation') || t.includes('land division')) return 'HOUSING';
  if (t.includes('aaps') || c.includes('aaps') || c.includes('school') || t.includes('street vacation')) return 'INFRA';
  return 'OTHER';
}

export function scaleFromDetroit(permitType, estimatedCost, numUnits) {
  const type = category(permitType); const cost = estimatedCost || 0; const units = numUnits || 0;
  if (['mechanical','electrical','plumbing','sign','fence','fire alarm','sprinkler'].some(x => type.includes(x))) return 'MINOR';
  if (type === 'new' || type.includes('new construction') || type.includes('new building')) return units >= 5 || cost >= 500000 ? 'MAJOR' : 'MODERATE';
  if (type.includes('demolition') || type.includes('demo')) return units >= 5 || cost >= 100000 ? 'MAJOR' : 'MODERATE';
  if (type.includes('addition')) return units >= 3 || cost >= 250000 ? 'MAJOR' : cost >= 50000 ? 'MODERATE' : 'MINOR';
  if (type.includes('alteration') || type.includes('renovation') || type.includes('remodel')) return cost >= 100000 ? 'MODERATE' : cost < 25000 ? 'MINOR' : 'MODERATE';
  if (cost >= 500000) return 'MAJOR'; if (cost >= 50000) return 'MODERATE'; if (cost < 15000 && cost > 0) return 'MINOR'; return 'MODERATE';
}

export function scaleFromAnnArbor(type, classField) {
  const t = category(type); const c = category(classField);
  if (t.includes('rezoning') || t.includes('rezone')) return 'MAJOR';
  if (t.includes('site plan')) return ['pud','planned unit','multi','apartment','mixed use','development'].some(x => c.includes(x)) ? 'MAJOR' : 'MODERATE';
  if (t.includes('design review') || t.includes('annexation') || t.includes('special use')) return 'MODERATE';
  if (t.includes('land division') || t.includes('lot split') || t.includes('zoning board') || t.includes('zba') || t.includes('variance')) return 'MINOR';
  return 'MODERATE';
}

function numberValue(value, integer = false) {
  if (value === null || value === undefined) return null;
  const n = typeof value === 'string'
    ? (integer ? Number.parseInt(value, 10) : Number.parseFloat(value))
    : value;
  return Number.isNaN(n) ? null : n;
}
function dateValue(value) { if (value === null || value === undefined) return null; const date = new Date(value); return Number.isNaN(date.getTime()) ? null : date; }

export function mapDetroitPermit(raw) {
  if (!raw?.record_id || !raw?.address) return null;
  const estimatedCost = numberValue(raw.amt_estimated_contractor_cost);
  const numUnits = numberValue(raw.num_units, true);
  const shortAddress = raw.address.split(',')[0];
  return {
    title: `${raw.permit_type || 'Development'}${raw.proposed_use_type && category(raw.proposed_use_type) !== 'unknown' ? ` - ${raw.proposed_use_type}` : ''} at ${shortAddress}`.slice(0, 500),
    description: raw.work_description || null, address: raw.address, city: 'DETROIT',
    category: categoryFromDetroit(raw.proposed_use_type, raw.use_group), scale: scaleFromDetroit(raw.permit_type, estimatedCost, numUnits),
    phase: raw.issued_date ? 'APPROVED' : 'PROPOSED', verification: 'VERIFIED', latitude: raw.latitude, longitude: raw.longitude,
    neighborhood: raw.neighborhood, zipCode: raw.zip_code, sourceType: 'PERMIT', sourceId: raw.record_id, sourceUrl: null,
    estimatedCost, numUnits, numStories: numberValue(raw.num_stories, true), permitType: raw.permit_type, zoningDesignation: raw.zoning_designation,
    submittedDate: dateValue(raw.submitted_date), approvedDate: dateValue(raw.issued_date), addressHash: createAddressHash(raw.address),
  };
}

export function mapAnnArborPlanCase(raw) {
  if (!raw?.PLANNUMBER || !raw?.ADDRESS) return null;
  const coords = raw.geometry && raw.geometry.x !== undefined && raw.geometry.y !== undefined ? { lat: raw.geometry.y, lng: raw.geometry.x } : null;
  const type = raw.TYPE || 'Planning Case';
  return {
    title: `${type}: ${raw.ADDRESS.split(',')[0]}`.slice(0, 500), description: `${raw.TYPE || 'Planning Case'}: ${raw.CLASS || 'N/A'}`,
    address: raw.ADDRESS, city: 'ANN_ARBOR', category: categoryFromAnnArbor(raw.TYPE, raw.CLASS), scale: scaleFromAnnArbor(raw.TYPE, raw.CLASS),
    phase: (() => { const status = category(raw.STATUS); if (status.includes('approved') || status.includes('complete') || status.includes('paid')) return 'APPROVED'; if (status.includes('denied') || status.includes('withdrawn')) return 'CANCELLED'; if (raw.COMPLETEYEAR) return 'COMPLETED'; return 'PROPOSED'; })(),
    verification: 'VERIFIED', latitude: coords?.lat || null, longitude: coords?.lng || null, neighborhood: null, zipCode: null,
    sourceType: 'PLANNING', sourceId: raw.PLANNUMBER, sourceUrl: raw.STREAMURL || null, estimatedCost: null, numUnits: null, numStories: null,
    permitType: raw.TYPE, zoningDesignation: null, submittedDate: raw.APPLICATIONYEAR ? new Date(`${raw.APPLICATIONYEAR}-01-01`) : null,
    approvedDate: null, completedDate: raw.COMPLETEYEAR ? new Date(`${raw.COMPLETEYEAR}-01-01`) : null, addressHash: createAddressHash(raw.ADDRESS),
  };
}
