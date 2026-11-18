// Demo reference data for two ports. Authorities and terminals reflect the real ports; every commercial party,
// vessel, B/L and container is fictitious (names end in "(demo)" where they could be mistaken for real companies).
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

export const PORTS = [
  {
    code: 'ROCND', name: 'Port of Constanța', country: 'RO', timezone: 'Europe/Bucharest', currency: 'RON', lat: 44.155, lon: 28.66,
    settings: {
      clearanceAgencies: ['HARBOUR_MASTER', 'CUSTOMS', 'BORDER_POLICE', 'PORT_HEALTH'], departureAgencies: ['HARBOUR_MASTER', 'CUSTOMS', 'BORDER_POLICE'],
      falFormsRequired: [1, 2, 3, 5, 6, 7], customsSystem: 'RO_CUSTOMS', languages: ['ro', 'en', 'uk'], vatRate: 0.21,
      truckSlotMinutes: 60, truckSlotCapacity: 25, bargeOperations: true, railOperations: true,
    },
    authorities: [
      ['CN Administrația Porturilor Maritime SA Constanța', 'PORT_AUTHORITY', ['PORT_ADMIN', 'HARBOUR_MASTER', 'FINANCE', 'EXECUTIVE']],
      ['Autoritatea Vamală Română — Biroul Vamal Constanța Sud', 'GOVERNMENT_AGENCY', ['CUSTOMS']],
      ['Poliția de Frontieră — Constanța', 'GOVERNMENT_AGENCY', ['BORDER_POLICE']],
      ['Direcția de Sănătate Publică Constanța', 'GOVERNMENT_AGENCY', ['PORT_HEALTH']],
      ['Autoritatea Navală Română', 'GOVERNMENT_AGENCY', ['MARITIME_SAFETY']],
    ],
    terminals: [
      { code: 'DPWC', name: 'DP World Constanța Container Terminal', type: 'CONTAINER', operator: 'DP World Constanța', lat: 44.104, lon: 28.651 },
      { code: 'SOCEP', name: 'SOCEP Terminal', type: 'CONTAINER', operator: 'SOCEP SA', lat: 44.152, lon: 28.66 },
      { code: 'COMVEX', name: 'Comvex Bulk Terminal', type: 'BULK', operator: 'Comvex SA', lat: 44.112, lon: 28.64 },
      { code: 'BARGE', name: 'Danube Barge Terminal', type: 'GENERAL', operator: 'SOCEP SA', lat: 44.095, lon: 28.627 },
    ],
    berths: [
      ['S1', 'Berth S1', 'DPWC', 350, 14.5, 44.106, 28.655], ['S2', 'Berth S2', 'DPWC', 350, 14.5, 44.102, 28.657],
      ['B34', 'Berth 34', 'SOCEP', 260, 12.5, 44.153, 28.662], ['B35', 'Berth 35', 'SOCEP', 240, 12.0, 44.150, 28.663],
      ['B80', 'Berth 80', 'COMVEX', 300, 19.0, 44.113, 28.643], ['BG1', 'Barge Berth 1', 'BARGE', 120, 4.5, 44.096, 28.628, true],
      ['BG2', 'Barge Berth 2', 'BARGE', 120, 4.5, 44.094, 28.626, true],
    ],
    commercial: [
      ['Black Sea Maritime Agency SRL (demo)', 'SHIPPING_AGENT'], ['Euxin Container Line (demo)', 'SHIPPING_LINE'],
      ['Dobrogea Freight Forwarding SRL (demo)', 'FREIGHT_FORWARDER'], ['Carpați Haulage SRL (demo)', 'HAULIER'],
      ['Danube Barge Lines SA (demo)', 'BARGE_OPERATOR'], ['Rail Cargo Constanța SRL (demo)', 'RAIL_OPERATOR'],
      ['Constanța Pilots & Towage SRL (demo)', 'SERVICE_PROVIDER'], ['Pontus Bunkering SRL (demo)', 'SERVICE_PROVIDER'],
    ],
    tariffs: [
      ['VC-PORT', 'Port dues (per GT)', 'VESSEL_CALL', 'PER_GT', 0.42, 500], ['VC-BERTH', 'Berth hire (per m LOA per day)', 'VESSEL_CALL', 'PER_LOA_DAY', 2.1, null],
      ['VC-LIGHT', 'Light and navigation dues', 'VESSEL_CALL', 'PER_CALL', 950, null], ['VC-TEU', 'Infrastructure fee (per TEU)', 'VESSEL_CALL', 'PER_TEU', 18, null],
      ['BC-DUES', 'Barge port dues (per tonne)', 'BARGE_CALL', 'PER_TONNE', 0.65, 150], ['DO-FEE', 'eDO processing fee', 'DELIVERY_ORDER', 'PER_CALL', 45, null],
      ['TA-FEE', 'Truck appointment / gate fee', 'TRUCK_APPOINTMENT', 'PER_CALL', 25, null],
    ],
    lastPorts: ['TRIST', 'GRPIR', 'EGPSD', 'UAODS', 'BGVAR'],
  },
  {
    code: 'NGAPP', name: 'Lagos Port Complex, Apapa', country: 'NG', timezone: 'Africa/Lagos', currency: 'NGN', lat: 6.44, lon: 3.365,
    settings: {
      clearanceAgencies: ['HARBOUR_MASTER', 'CUSTOMS', 'IMMIGRATION', 'PORT_HEALTH', 'MARITIME_SAFETY'], departureAgencies: ['HARBOUR_MASTER', 'CUSTOMS', 'IMMIGRATION'],
      falFormsRequired: [1, 2, 3, 5, 6, 7], customsSystem: 'NICIS_II', languages: ['en'], vatRate: 0.075,
      truckSlotMinutes: 60, truckSlotCapacity: 40, bargeOperations: true, railOperations: true,
    },
    authorities: [
      ['Nigerian Ports Authority', 'PORT_AUTHORITY', ['PORT_ADMIN', 'HARBOUR_MASTER', 'FINANCE', 'EXECUTIVE']],
      ['Nigeria Customs Service — Apapa Command', 'GOVERNMENT_AGENCY', ['CUSTOMS']],
      ['Nigeria Immigration Service', 'GOVERNMENT_AGENCY', ['IMMIGRATION']],
      ['Port Health Services', 'GOVERNMENT_AGENCY', ['PORT_HEALTH']],
      ['NIMASA', 'GOVERNMENT_AGENCY', ['MARITIME_SAFETY']],
    ],
    terminals: [
      { code: 'APMT', name: 'APM Terminals Apapa', type: 'CONTAINER', operator: 'APM Terminals Apapa', lat: 6.437, lon: 3.372 },
      { code: 'ENL', name: 'ENL Consortium Terminal', type: 'GENERAL', operator: 'ENL Consortium', lat: 6.444, lon: 3.366 },
      { code: 'BARGE', name: 'Apapa Barge Jetty', type: 'GENERAL', operator: 'ENL Consortium', lat: 6.449, lon: 3.362 },
    ],
    berths: [
      ['A1', 'Apapa Berth 1', 'APMT', 300, 13.5, 6.436, 3.373], ['A2', 'Apapa Berth 2', 'APMT', 300, 13.5, 6.434, 3.375],
      ['E7', 'Berth 7', 'ENL', 220, 11.0, 6.443, 3.367], ['E8', 'Berth 8', 'ENL', 220, 11.0, 6.445, 3.365],
      ['J1', 'Barge Jetty 1', 'BARGE', 90, 4.0, 6.449, 3.362, true],
    ],
    commercial: [
      ['Eko Shipping Agencies Ltd (demo)', 'SHIPPING_AGENT'], ['Gulf of Guinea Lines (demo)', 'SHIPPING_LINE'],
      ['Marina Clearing & Forwarding Ltd (demo)', 'FREIGHT_FORWARDER'], ['Ikeja Haulage Ltd (demo)', 'HAULIER'],
      ['Lagos Lagoon Barges Ltd (demo)', 'BARGE_OPERATOR'], ['Western Rail Freight Ltd (demo)', 'RAIL_OPERATOR'],
      ['Apapa Marine Services Ltd (demo)', 'SERVICE_PROVIDER'], ['Atlantic Bunkers Ltd (demo)', 'SERVICE_PROVIDER'],
    ],
    tariffs: [
      ['VC-PORT', 'Port dues (per GT)', 'VESSEL_CALL', 'PER_GT', 85, 150000], ['VC-BERTH', 'Berthing fee (per m LOA per day)', 'VESSEL_CALL', 'PER_LOA_DAY', 420, null],
      ['VC-LIGHT', 'Light dues', 'VESSEL_CALL', 'PER_CALL', 250000, null], ['VC-TEU', 'Cargo dues (per TEU)', 'VESSEL_CALL', 'PER_TEU', 3500, null],
      ['BC-DUES', 'Barge dues (per tonne)', 'BARGE_CALL', 'PER_TONNE', 120, 25000], ['DO-FEE', 'eDO processing fee', 'DELIVERY_ORDER', 'PER_CALL', 12000, null],
      ['TA-FEE', 'Truck call-up fee', 'TRUCK_APPOINTMENT', 'PER_CALL', 6500, null],
    ],
    lastPorts: ['GHTEM', 'CIABJ', 'TGLFW', 'BJCOO', 'ESALG'],
  },
] as const;

export const VESSELS = [
  { imo: imo('930112'), name: 'EUXIN STAR', type: 'CONTAINER', flag: 'MT', gt: 54200, dwt: 63000, loa: 294, beam: 32.3, max_draft: 12.8, call_sign: '9HA4521', mmsi: '248112000' },
  { imo: imo('941207'), name: 'DOBROGEA', type: 'CONTAINER', flag: 'LR', gt: 28900, dwt: 34000, loa: 222, beam: 30, max_draft: 11.2, call_sign: 'D5RT4', mmsi: '636019872' },
  { imo: imo('952318'), name: 'BLACK SEA PIONEER', type: 'BULK_CARRIER', flag: 'PA', gt: 43000, dwt: 81000, loa: 229, beam: 32.2, max_draft: 14.4, call_sign: '3FPN7', mmsi: '352001233' },
  { imo: imo('963424'), name: 'ATLANTIC HARMONY', type: 'CONTAINER', flag: 'MH', gt: 40100, dwt: 50500, loa: 260, beam: 32.2, max_draft: 12.5, call_sign: 'V7AH9', mmsi: '538007711' },
  { imo: imo('974535'), name: 'LAGOS EXPRESS', type: 'CONTAINER', flag: 'LR', gt: 25300, dwt: 30100, loa: 208, beam: 29.8, max_draft: 10.9, call_sign: 'D5LX2', mmsi: '636020044' },
  { imo: imo('985641'), name: 'GULF TRADER', type: 'GENERAL_CARGO', flag: 'SG', gt: 12100, dwt: 17000, loa: 156, beam: 24, max_draft: 9.5, call_sign: '9VGT3', mmsi: '563110022' },
  { imo: imo('916752'), name: 'PONTUS SPIRIT', type: 'TANKER', flag: 'MT', gt: 29700, dwt: 50000, loa: 183, beam: 32.2, max_draft: 12.2, call_sign: '9HPS8', mmsi: '248330090' },
  { imo: imo('927863'), name: 'NIGER DELTA', type: 'CONTAINER', flag: 'NG', gt: 18400, dwt: 23000, loa: 175, beam: 27.4, max_draft: 10.1, call_sign: '5NND1', mmsi: '657120030' },
];

export const LOCATIONS = [
  ['ROCND', 'Constanța', 'RO'], ['NGAPP', 'Apapa', 'NG'], ['NGLOS', 'Lagos', 'NG'], ['TRIST', 'Istanbul', 'TR'], ['GRPIR', 'Piraeus', 'GR'],
  ['EGPSD', 'Port Said', 'EG'], ['UAODS', 'Odesa', 'UA'], ['BGVAR', 'Varna', 'BG'], ['GHTEM', 'Tema', 'GH'], ['CIABJ', 'Abidjan', 'CI'],
  ['TGLFW', 'Lomé', 'TG'], ['BJCOO', 'Cotonou', 'BJ'], ['ESALG', 'Algeciras', 'ES'], ['AEJEA', 'Jebel Ali', 'AE'], ['AEKHL', 'Khalifa Port', 'AE'],
  ['CNSHA', 'Shanghai', 'CN'], ['SGSIN', 'Singapore', 'SG'], ['NLRTM', 'Rotterdam', 'NL'], ['DEHAM', 'Hamburg', 'DE'], ['RSBEG', 'Belgrade', 'RS'],
  ['HUBUD', 'Budapest', 'HU'], ['ATVIE', 'Vienna', 'AT'], ['ROGLU', 'Galați', 'RO'], ['NGKAN', 'Kano', 'NG'],
];
