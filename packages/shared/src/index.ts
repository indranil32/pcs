// Shared domain model for the PCS — imported by the API and the web portal.
// Module codes follow PCS PRD v2.1 (FR-PLT, FR-VES, FR-CGO, FR-CUS, FR-GAT, FR-TRS, FR-FIN, FR-SWN, ...).

export * from './state.js';
export * from './validators.js';

export const ROLES = [
  'SYS_ADMIN',          // platform super-admin (cross-tenant)
  'PORT_ADMIN',         // port authority PCS administrator
  'HARBOUR_MASTER',     // port authority marine operations / berth planning
  'SHIPPING_AGENT',
  'SHIPPING_LINE',
  'CUSTOMS',
  'IMMIGRATION',
  'BORDER_POLICE',
  'PORT_HEALTH',
  'MARITIME_SAFETY',    // maritime safety / flag-state administration
  'TERMINAL_OPERATOR',
  'FREIGHT_FORWARDER',  // CHA / customs broker / forwarder
  'HAULIER',
  'RAIL_OPERATOR',
  'BARGE_OPERATOR',
  'SERVICE_PROVIDER',   // pilotage, towage, bunkering, waste...
  'FACILITY_OPERATOR',  // dry port (ICD), empty container depot, container freight station (CFS)
  'FINANCE',
  'EXECUTIVE',          // read-only dashboards
] as const;
export type Role = (typeof ROLES)[number];

/** Government / authority roles see every record in their port (tenant). */
export const AUTHORITY_ROLES: Role[] = [
  'SYS_ADMIN', 'PORT_ADMIN', 'HARBOUR_MASTER', 'CUSTOMS', 'IMMIGRATION', 'BORDER_POLICE',
  'PORT_HEALTH', 'MARITIME_SAFETY', 'FINANCE', 'EXECUTIVE',
];

/** Agencies that can take part in vessel clearance (configured per port). */
export const AGENCIES = ['HARBOUR_MASTER', 'CUSTOMS', 'IMMIGRATION', 'BORDER_POLICE', 'PORT_HEALTH', 'MARITIME_SAFETY'] as const;
export type Agency = (typeof AGENCIES)[number];

export const ORG_TYPES = [
  'PORT_AUTHORITY', 'GOVERNMENT_AGENCY', 'SHIPPING_AGENT', 'SHIPPING_LINE', 'TERMINAL_OPERATOR',
  'FREIGHT_FORWARDER', 'HAULIER', 'RAIL_OPERATOR', 'BARGE_OPERATOR', 'SERVICE_PROVIDER', 'IMPORTER_EXPORTER',
  'INLAND_FACILITY',
] as const;
export type OrgType = (typeof ORG_TYPES)[number];

/** Default role granted to the first user of a newly approved organisation. */
export const ORG_DEFAULT_ROLE: Record<OrgType, Role> = {
  PORT_AUTHORITY: 'PORT_ADMIN',
  GOVERNMENT_AGENCY: 'CUSTOMS',
  SHIPPING_AGENT: 'SHIPPING_AGENT',
  SHIPPING_LINE: 'SHIPPING_LINE',
  TERMINAL_OPERATOR: 'TERMINAL_OPERATOR',
  FREIGHT_FORWARDER: 'FREIGHT_FORWARDER',
  HAULIER: 'HAULIER',
  RAIL_OPERATOR: 'RAIL_OPERATOR',
  BARGE_OPERATOR: 'BARGE_OPERATOR',
  SERVICE_PROVIDER: 'SERVICE_PROVIDER',
  IMPORTER_EXPORTER: 'FREIGHT_FORWARDER',
  INLAND_FACILITY: 'FACILITY_OPERATOR',
};

export const SERVICE_TYPES = [
  'PILOTAGE', 'TOWAGE', 'MOORING', 'BUNKERING', 'FRESH_WATER', 'WASTE_COLLECTION',
  'PROVISIONS', 'CREW_CHANGE', 'SURVEY', 'REPAIRS',
] as const;
export type ServiceType = (typeof SERVICE_TYPES)[number];

/** IMO FAL Convention forms. FAL 4 (crew effects) is excluded by default — held by the master, GDPR-sensitive (IPCSA note). */
export const FAL_FORMS = [
  { no: 1, code: 'FAL1', name: 'General Declaration' },
  { no: 2, code: 'FAL2', name: 'Cargo Declaration' },
  { no: 3, code: 'FAL3', name: "Ship's Stores Declaration" },
  { no: 4, code: 'FAL4', name: "Crew's Effects Declaration" },
  { no: 5, code: 'FAL5', name: 'Crew List' },
  { no: 6, code: 'FAL6', name: 'Passenger List' },
  { no: 7, code: 'FAL7', name: 'Dangerous Goods Manifest' },
] as const;

export const EDI_MESSAGE_TYPES = ['CUSCAR', 'CODECO', 'COARRI', 'BERMAN', 'BAPLIE', 'COPRAR', 'IFTDGN', 'APERAK', 'CUSRES'] as const;

export const LANGUAGES = ['en', 'ro', 'uk'] as const;
export type Lang = (typeof LANGUAGES)[number];

export interface TenantSettings {
  clearanceAgencies: Agency[];
  falFormsRequired: number[];
  customsSystem: 'MOCK' | 'REST_API' | 'EDIFACT';
  languages: Lang[];
  vatRate: number;
  truckSlotMinutes: number;
  truckSlotCapacity: number;
  bargeOperations: boolean;
  railOperations: boolean;
}
