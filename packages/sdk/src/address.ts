/**
 * How an address is asked for in a given country: what the region and postal
 * fields are called, whether they are required, and — where carriers expect a
 * code — the list of regions to choose from. Countries not listed get a
 * neutral, optional "State / province / region" and "Postal code".
 */
export interface AddressFormat {
  regionLabel: string
  /** Choose-from list as [code, name]; the code is what is stored and sent to carriers. */
  regions?: [string, string][]
  regionRequired: boolean
  postalLabel: string
  postalRequired: boolean
  /** Checked on the server and as the input's pattern. */
  postalPattern?: string
  postalExample?: string
}

const US_STATES: [string, string][] = [
  ['AL', 'Alabama'], ['AK', 'Alaska'], ['AZ', 'Arizona'], ['AR', 'Arkansas'], ['CA', 'California'], ['CO', 'Colorado'],
  ['CT', 'Connecticut'], ['DE', 'Delaware'], ['DC', 'District of Columbia'], ['FL', 'Florida'], ['GA', 'Georgia'], ['HI', 'Hawaii'],
  ['ID', 'Idaho'], ['IL', 'Illinois'], ['IN', 'Indiana'], ['IA', 'Iowa'], ['KS', 'Kansas'], ['KY', 'Kentucky'], ['LA', 'Louisiana'],
  ['ME', 'Maine'], ['MD', 'Maryland'], ['MA', 'Massachusetts'], ['MI', 'Michigan'], ['MN', 'Minnesota'], ['MS', 'Mississippi'],
  ['MO', 'Missouri'], ['MT', 'Montana'], ['NE', 'Nebraska'], ['NV', 'Nevada'], ['NH', 'New Hampshire'], ['NJ', 'New Jersey'],
  ['NM', 'New Mexico'], ['NY', 'New York'], ['NC', 'North Carolina'], ['ND', 'North Dakota'], ['OH', 'Ohio'], ['OK', 'Oklahoma'],
  ['OR', 'Oregon'], ['PA', 'Pennsylvania'], ['RI', 'Rhode Island'], ['SC', 'South Carolina'], ['SD', 'South Dakota'],
  ['TN', 'Tennessee'], ['TX', 'Texas'], ['UT', 'Utah'], ['VT', 'Vermont'], ['VA', 'Virginia'], ['WA', 'Washington'],
  ['WV', 'West Virginia'], ['WI', 'Wisconsin'], ['WY', 'Wyoming'],
  ['PR', 'Puerto Rico'], ['GU', 'Guam'], ['VI', 'U.S. Virgin Islands'], ['AS', 'American Samoa'], ['MP', 'Northern Mariana Islands'],
  ['AA', 'Armed Forces Americas'], ['AE', 'Armed Forces Europe'], ['AP', 'Armed Forces Pacific'],
]
const CA_PROVINCES: [string, string][] = [
  ['AB', 'Alberta'], ['BC', 'British Columbia'], ['MB', 'Manitoba'], ['NB', 'New Brunswick'], ['NL', 'Newfoundland and Labrador'],
  ['NS', 'Nova Scotia'], ['NT', 'Northwest Territories'], ['NU', 'Nunavut'], ['ON', 'Ontario'], ['PE', 'Prince Edward Island'],
  ['QC', 'Quebec'], ['SK', 'Saskatchewan'], ['YT', 'Yukon'],
]
const AU_STATES: [string, string][] = [
  ['ACT', 'Australian Capital Territory'], ['NSW', 'New South Wales'], ['NT', 'Northern Territory'], ['QLD', 'Queensland'],
  ['SA', 'South Australia'], ['TAS', 'Tasmania'], ['VIC', 'Victoria'], ['WA', 'Western Australia'],
]

const FORMATS: Record<string, AddressFormat> = {
  US: { regionLabel: 'State', regions: US_STATES, regionRequired: true, postalLabel: 'ZIP code', postalRequired: true, postalPattern: '^\\d{5}(-\\d{4})?$', postalExample: '89101' },
  CA: { regionLabel: 'Province', regions: CA_PROVINCES, regionRequired: true, postalLabel: 'Postal code', postalRequired: true, postalPattern: '^[A-Za-z]\\d[A-Za-z] ?\\d[A-Za-z]\\d$', postalExample: 'K1A 0B1' },
  AU: { regionLabel: 'State / territory', regions: AU_STATES, regionRequired: true, postalLabel: 'Postcode', postalRequired: true, postalPattern: '^\\d{4}$', postalExample: '2000' },
  GB: { regionLabel: 'County (optional)', regionRequired: false, postalLabel: 'Postcode', postalRequired: true },
  IE: { regionLabel: 'County', regionRequired: false, postalLabel: 'Eircode (optional)', postalRequired: false },
  NZ: { regionLabel: 'Region (optional)', regionRequired: false, postalLabel: 'Postcode', postalRequired: true, postalPattern: '^\\d{4}$' },
  MX: { regionLabel: 'State', regionRequired: true, postalLabel: 'Postal code', postalRequired: true, postalPattern: '^\\d{5}$' },
  BR: { regionLabel: 'State', regionRequired: true, postalLabel: 'CEP', postalRequired: true, postalPattern: '^\\d{5}-?\\d{3}$' },
  JP: { regionLabel: 'Prefecture', regionRequired: true, postalLabel: 'Postal code', postalRequired: true, postalPattern: '^\\d{3}-?\\d{4}$' },
  DE: { regionLabel: 'State (optional)', regionRequired: false, postalLabel: 'Postcode', postalRequired: true, postalPattern: '^\\d{5}$' },
}
const DEFAULT_FORMAT: AddressFormat = { regionLabel: 'State / province / region', regionRequired: false, postalLabel: 'Postal code', postalRequired: false }

export function addressFormat(country: string | null | undefined): AddressFormat {
  return FORMATS[(country ?? '').toUpperCase()] ?? DEFAULT_FORMAT
}

/** Formats for a set of countries, for the checkout page to switch between without a round trip. */
export function addressFormats(countries: string[]): Record<string, AddressFormat> {
  return Object.fromEntries(countries.map((c) => [c.toUpperCase(), addressFormat(c)]))
}

/**
 * Field errors for an address against its country's format; also normalises
 * a region given by name ("Nevada") to its code ("NV"). Mutates `address`.
 */
export function checkAddressFormat(address: { country?: string; state?: string; postalCode?: string }): Record<string, string> {
  const f = addressFormat(address.country)
  const details: Record<string, string> = {}
  const state = address.state?.trim() ?? ''
  if (f.regions && state) {
    const hit = f.regions.find(([code, name]) => code.toLowerCase() === state.toLowerCase() || name.toLowerCase() === state.toLowerCase())
    if (hit) address.state = hit[0]
    else details['shipping_address.state'] = `is not a ${f.regionLabel.toLowerCase()}`
  } else if (f.regionRequired && !state) details['shipping_address.state'] = 'is required'
  const postal = address.postalCode?.trim() ?? ''
  if (!postal && f.postalRequired) details['shipping_address.postal_code'] = 'is required'
  else if (postal && f.postalPattern && !new RegExp(f.postalPattern).test(postal)) details['shipping_address.postal_code'] = `doesn't look like a ${f.postalLabel}${f.postalExample ? ` (e.g. ${f.postalExample})` : ''}`
  return details
}
