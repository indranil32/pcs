// Demo reference data for two FICTIONAL ports. Everything here is synthetic: port and company names, vessels,
// B/Ls and containers. UN/LOCODEs use the ISO 3166 user-assigned code "ZZ"; map coordinates sit in open ocean
// near 0°/0° so the demo never points at a real place.
import { containerCheckDigit } from '@pcs/shared';

export function imo(six: string) {
  let s = 0;
  for (let i = 0; i < 6; i++) s += Number(six[i]) * (7 - i);
  return six + (s % 10);
}
export function cntr(owner4: string, serial6: string) {
  const p = owner4 + serial6;
  return p + containerCheckDigit(p);
}

const AUTHORITIES_A = [
  ['Demo Port Alpha Authority', 'PORT_AUTHORITY', ['PORT_ADMIN', 'HARBOUR_MASTER', 'FINANCE', 'EXECUTIVE']],
  ['Customs Administration (demo)', 'GOVERNMENT_AGENCY', ['CUSTOMS']],
  ['Border Police (demo)', 'GOVERNMENT_AGENCY', ['BORDER_POLICE']],
  ['Port Health Authority (demo)', 'GOVERNMENT_AGENCY', ['PORT_HEALTH']],
  ['Maritime Safety Administration (demo)', 'GOVERNMENT_AGENCY', ['MARITIME_SAFETY']],
] as const;
const AUTHORITIES_B = [
  ['Demo Port Beta Authority', 'PORT_AUTHORITY', ['PORT_ADMIN', 'HARBOUR_MASTER', 'FINANCE', 'EXECUTIVE']],
  ['Customs Service (demo)', 'GOVERNMENT_AGENCY', ['CUSTOMS']],
  ['Immigration Service (demo)', 'GOVERNMENT_AGENCY', ['IMMIGRATION']],
  ['Port Health Services (demo)', 'GOVERNMENT_AGENCY', ['PORT_HEALTH']],
  ['Maritime Administration (demo)', 'GOVERNMENT_AGENCY', ['MARITIME_SAFETY']],
] as const;

const INLAND_TARIFFS = (k: number) => [
  ['IT-TEU', 'Bonded inland transfer handling (per TEU)', 'INLAND_TRANSFER', 'PER_TEU', 12 * k, null],
  ['FM-LIFT', 'Facility lift on / lift off (per container)', 'FACILITY_MOVE', 'PER_CALL', 18 * k, null],
  ['FM-STOR', 'Facility storage beyond free days (per container-day)', 'FACILITY_MOVE', 'PER_UNIT_DAY', 6 * k, null],
  ['CFS-JOB', 'CFS container handling (stuffing / destuffing)', 'CFS_JOB', 'PER_CALL', 45 * k, null],
  ['CFS-M3', 'CFS cargo handling (per m3)', 'CFS_JOB', 'PER_M3', 9 * k, null],
] as const;

export const PORTS = [
  {
    code: 'ZZALP', name: 'Demo Port Alpha', country: 'ZZ', timezone: 'UTC', currency: 'EUR', lat: 0.02, lon: 0.02,
    owner: 'ALPU', plates: 'AL',
    settings: {
      clearanceAgencies: ['HARBOUR_MASTER', 'CUSTOMS', 'BORDER_POLICE', 'PORT_HEALTH'], departureAgencies: ['HARBOUR_MASTER', 'CUSTOMS', 'BORDER_POLICE'],
      falFormsRequired: [1, 2, 3, 5, 6, 7], customsSystem: 'MOCK', languages: ['en', 'ro', 'uk'], vatRate: 0.2,
      truckSlotMinutes: 60, truckSlotCapacity: 25, bargeOperations: true, railOperations: true,
    },
    authorities: AUTHORITIES_A,
    terminals: [
      { code: 'CT1', name: 'Container Terminal 1', type: 'CONTAINER', operator: 'Alpha Container Terminals (demo)', lat: 0.004, lon: 0.012 },
      { code: 'CT2', name: 'Container Terminal 2', type: 'CONTAINER', operator: 'Northside Terminals (demo)', lat: 0.03, lon: 0.022 },
      { code: 'BLK', name: 'Dry Bulk Terminal', type: 'BULK', operator: 'Bulk Handling Co (demo)', lat: 0.012, lon: 0.002 },
      { code: 'BARGE', name: 'Inland Barge Terminal', type: 'GENERAL', operator: 'Northside Terminals (demo)', lat: -0.004, lon: -0.008 },
    ],
    berths: [
      ['A1', 'Berth A1', 'CT1', 350, 14.5, 0.006, 0.016], ['A2', 'Berth A2', 'CT1', 350, 14.5, 0.002, 0.018],
      ['N1', 'Berth N1', 'CT2', 260, 12.5, 0.032, 0.026], ['N2', 'Berth N2', 'CT2', 240, 12.0, 0.028, 0.027],
      ['B1', 'Bulk Berth B1', 'BLK', 300, 19.0, 0.013, 0.005], ['BG1', 'Barge Berth 1', 'BARGE', 120, 4.5, -0.003, -0.006, true],
      ['BG2', 'Barge Berth 2', 'BARGE', 120, 4.5, -0.005, -0.008, true],
    ],
    commercial: [
      ['Harbour Line Agency (demo)', 'SHIPPING_AGENT'], ['Blue Meridian Line (demo)', 'SHIPPING_LINE'],
      ['Coastal Freight Forwarding (demo)', 'FREIGHT_FORWARDER'], ['Highway Haulage (demo)', 'HAULIER'],
      ['River Barge Lines (demo)', 'BARGE_OPERATOR'], ['Inland Rail Cargo (demo)', 'RAIL_OPERATOR'],
      ['Pilots & Towage Services (demo)', 'SERVICE_PROVIDER'], ['Marine Fuel Supply (demo)', 'SERVICE_PROVIDER'],
    ],
    tariffs: [
      ['VC-PORT', 'Port dues (per GT)', 'VESSEL_CALL', 'PER_GT', 0.09, 300], ['VC-BERTH', 'Berth hire (per m LOA per day)', 'VESSEL_CALL', 'PER_LOA_DAY', 0.45, null],
      ['VC-LIGHT', 'Light and navigation dues', 'VESSEL_CALL', 'PER_CALL', 190, null], ['VC-TEU', 'Infrastructure fee (per TEU)', 'VESSEL_CALL', 'PER_TEU', 3.5, null],
      ['BC-DUES', 'Barge port dues (per tonne)', 'BARGE_CALL', 'PER_TONNE', 0.13, 30], ['DO-FEE', 'eDO processing fee', 'DELIVERY_ORDER', 'PER_CALL', 9, null],
      ['TA-FEE', 'Truck appointment / gate fee', 'TRUCK_APPOINTMENT', 'PER_CALL', 5, null],
      ...INLAND_TARIFFS(1),
    ],
    facilities: [
      { code: 'ICD1', name: 'North Inland Container Depot', type: 'DRY_PORT', operator: 'Inland Logistics Park (demo)', login: 'icd', location: 'ZZINL', lat: 0.21, lon: -0.31, distanceKm: 86, bonded: true, capacityTeu: 6000, transitHours: 30 },
      { code: 'DEP1', name: 'Harbour Empty Depot', type: 'EMPTY_DEPOT', operator: 'Harbour Container Services (demo)', login: 'depot', location: 'ZZALP', lat: -0.012, lon: -0.03, distanceKm: 6, bonded: false, capacityTeu: 3500 },
      { code: 'CFS1', name: 'Alpha Container Freight Station', type: 'CFS', operator: 'Consolidated Cargo Station (demo)', login: 'cfs', location: 'ZZALP', lat: 0.034, lon: -0.022, distanceKm: 4, bonded: true, capacityTeu: 400, capacityM3: 18000, transitHours: 6 },
    ],
    lastPorts: ['ZZNRT', 'ZZSTH', 'ZZEST', 'ZZWST', 'ZZCTR'],
    bargeOrigin: 'ZZRVR', railDestination: 'ZZINL',
  },
  {
    code: 'ZZBET', name: 'Demo Port Beta', country: 'ZZ', timezone: 'UTC', currency: 'USD', lat: 0.02, lon: 1.02,
    owner: 'BETU', plates: 'BT',
    settings: {
      clearanceAgencies: ['HARBOUR_MASTER', 'CUSTOMS', 'IMMIGRATION', 'PORT_HEALTH', 'MARITIME_SAFETY'], departureAgencies: ['HARBOUR_MASTER', 'CUSTOMS', 'IMMIGRATION'],
      falFormsRequired: [1, 2, 3, 5, 6, 7], customsSystem: 'MOCK', languages: ['en'], vatRate: 0.075,
      truckSlotMinutes: 60, truckSlotCapacity: 40, bargeOperations: true, railOperations: true,
    },
    authorities: AUTHORITIES_B,
    terminals: [
      { code: 'BCT', name: 'Beta Container Terminal', type: 'CONTAINER', operator: 'Beta Terminal Operations (demo)', lat: 0.004, lon: 1.024 },
      { code: 'GCT', name: 'General Cargo Terminal', type: 'GENERAL', operator: 'General Cargo Services (demo)', lat: 0.024, lon: 1.012 },
      { code: 'BARGE', name: 'Barge Jetty', type: 'GENERAL', operator: 'General Cargo Services (demo)', lat: 0.036, lon: 1.004 },
    ],
    berths: [
      ['C1', 'Berth C1', 'BCT', 300, 13.5, 0.003, 1.027], ['C2', 'Berth C2', 'BCT', 300, 13.5, 0.0, 1.029],
      ['G7', 'Berth G7', 'GCT', 220, 11.0, 0.022, 1.016], ['G8', 'Berth G8', 'GCT', 220, 11.0, 0.026, 1.014],
      ['J1', 'Barge Jetty 1', 'BARGE', 90, 4.0, 0.037, 1.002, true],
    ],
    commercial: [
      ['Seaboard Shipping Agency (demo)', 'SHIPPING_AGENT'], ['Equator Container Line (demo)', 'SHIPPING_LINE'],
      ['Gateway Clearing & Forwarding (demo)', 'FREIGHT_FORWARDER'], ['Metro Haulage (demo)', 'HAULIER'],
      ['Delta Barge Services (demo)', 'BARGE_OPERATOR'], ['Western Rail Freight (demo)', 'RAIL_OPERATOR'],
      ['Harbour Marine Services (demo)', 'SERVICE_PROVIDER'], ['Ocean Bunkers (demo)', 'SERVICE_PROVIDER'],
    ],
    tariffs: [
      ['VC-PORT', 'Port dues (per GT)', 'VESSEL_CALL', 'PER_GT', 0.1, 350], ['VC-BERTH', 'Berthing fee (per m LOA per day)', 'VESSEL_CALL', 'PER_LOA_DAY', 0.5, null],
      ['VC-LIGHT', 'Light dues', 'VESSEL_CALL', 'PER_CALL', 220, null], ['VC-TEU', 'Cargo dues (per TEU)', 'VESSEL_CALL', 'PER_TEU', 4, null],
      ['BC-DUES', 'Barge dues (per tonne)', 'BARGE_CALL', 'PER_TONNE', 0.15, 35], ['DO-FEE', 'eDO processing fee', 'DELIVERY_ORDER', 'PER_CALL', 10, null],
      ['TA-FEE', 'Truck appointment fee', 'TRUCK_APPOINTMENT', 'PER_CALL', 6, null],
      ...INLAND_TARIFFS(1.15),
    ],
    facilities: [
      { code: 'DRY1', name: 'Central Dry Port', type: 'DRY_PORT', operator: 'Central Dry Port Company (demo)', login: 'icd', location: 'ZZINL', lat: 0.31, lon: 0.62, distanceKm: 140, bonded: true, capacityTeu: 9000, transitHours: 48 },
      { code: 'ECD1', name: 'Beta Empty Container Depot', type: 'EMPTY_DEPOT', operator: 'Beta Depot Services (demo)', login: 'depot', location: 'ZZBET', lat: 0.03, lon: 0.99, distanceKm: 8, bonded: false, capacityTeu: 2500 },
      { code: 'CFS1', name: 'Beta Freight Station', type: 'CFS', operator: 'Beta Freight Station Ltd (demo)', login: 'cfs', location: 'ZZBET', lat: 0.012, lon: 1.0, distanceKm: 5, bonded: true, capacityTeu: 300, capacityM3: 12000, transitHours: 6 },
    ],
    lastPorts: ['ZZEST', 'ZZWST', 'ZZNRT', 'ZZSTH', 'ZZCTR'],
    bargeOrigin: 'ZZDLT', railDestination: 'ZZINL',
  },
];

export const VESSELS = [
  { imo: imo('930112'), name: 'OCEAN PIONEER', type: 'CONTAINER', flag: 'ZZ', gt: 54200, dwt: 63000, loa: 294, beam: 32.3, max_draft: 12.8, call_sign: 'ZZOP1', mmsi: '999112000' },
  { imo: imo('941207'), name: 'COASTAL SPIRIT', type: 'CONTAINER', flag: 'ZZ', gt: 28900, dwt: 34000, loa: 222, beam: 30, max_draft: 11.2, call_sign: 'ZZCS2', mmsi: '999019872' },
  { imo: imo('952318'), name: 'BULK ENDEAVOUR', type: 'BULK_CARRIER', flag: 'ZZ', gt: 43000, dwt: 81000, loa: 229, beam: 32.2, max_draft: 14.4, call_sign: 'ZZBE3', mmsi: '999001233' },
  { imo: imo('963424'), name: 'MERIDIAN HARMONY', type: 'CONTAINER', flag: 'ZZ', gt: 40100, dwt: 50500, loa: 260, beam: 32.2, max_draft: 12.5, call_sign: 'ZZMH4', mmsi: '999007711' },
  { imo: imo('974535'), name: 'HARBOUR EXPRESS', type: 'CONTAINER', flag: 'ZZ', gt: 25300, dwt: 30100, loa: 208, beam: 29.8, max_draft: 10.9, call_sign: 'ZZHE5', mmsi: '999020044' },
  { imo: imo('985641'), name: 'GLOBAL TRADER', type: 'GENERAL_CARGO', flag: 'ZZ', gt: 12100, dwt: 17000, loa: 156, beam: 24, max_draft: 9.5, call_sign: 'ZZGT6', mmsi: '999110022' },
  { imo: imo('916752'), name: 'SEA VOYAGER', type: 'TANKER', flag: 'ZZ', gt: 29700, dwt: 50000, loa: 183, beam: 32.2, max_draft: 12.2, call_sign: 'ZZSV7', mmsi: '999330090' },
  { imo: imo('927863'), name: 'EQUATOR STAR', type: 'CONTAINER', flag: 'ZZ', gt: 18400, dwt: 23000, loa: 175, beam: 27.4, max_draft: 10.1, call_sign: 'ZZES8', mmsi: '999120030' },
];

// Fictional locations (ZZ = user-assigned code)
export const LOCATIONS = [
  ['ZZALP', 'Demo Port Alpha', 'ZZ'], ['ZZBET', 'Demo Port Beta', 'ZZ'], ['ZZNRT', 'North Harbour', 'ZZ'], ['ZZSTH', 'South Harbour', 'ZZ'],
  ['ZZEST', 'East Bay', 'ZZ'], ['ZZWST', 'West Point', 'ZZ'], ['ZZCTR', 'Central Port', 'ZZ'], ['ZZRVR', 'River Port', 'ZZ'],
  ['ZZDLT', 'Delta Port', 'ZZ'], ['ZZINL', 'Inland Hub', 'ZZ'],
];
