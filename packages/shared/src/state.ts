// State machines for PCS documents. The API enforces them; the portal uses them to show valid actions.

export type Transitions<S extends string> = Record<S, readonly S[]>;

export const VESSEL_CALL_STATUS = [
  'DRAFT', 'BERTH_REQUESTED', 'BERTH_ALLOCATED', 'PRE_ARRIVAL_SUBMITTED', 'ARRIVAL_CLEARED',
  'ARRIVED', 'BERTHED', 'DEPARTURE_REQUESTED', 'DEPARTURE_CLEARED', 'DEPARTED', 'CANCELLED',
] as const;
export type VesselCallStatus = (typeof VESSEL_CALL_STATUS)[number];

export const VESSEL_CALL_FLOW: Transitions<VesselCallStatus> = {
  DRAFT: ['BERTH_REQUESTED', 'CANCELLED'],
  BERTH_REQUESTED: ['BERTH_ALLOCATED', 'DRAFT', 'CANCELLED'],
  BERTH_ALLOCATED: ['PRE_ARRIVAL_SUBMITTED', 'BERTH_REQUESTED', 'CANCELLED'],
  PRE_ARRIVAL_SUBMITTED: ['ARRIVAL_CLEARED', 'BERTH_ALLOCATED', 'CANCELLED'],
  ARRIVAL_CLEARED: ['ARRIVED', 'CANCELLED'],
  ARRIVED: ['BERTHED'],
  BERTHED: ['DEPARTURE_REQUESTED'],
  DEPARTURE_REQUESTED: ['DEPARTURE_CLEARED', 'BERTHED'],
  DEPARTURE_CLEARED: ['DEPARTED'],
  DEPARTED: [],
  CANCELLED: [],
};

export const APPROVAL_STATUS = ['PENDING', 'APPROVED', 'REJECTED', 'QUERY'] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUS)[number];

export const CUSTOMS_STATUS = ['NOT_DECLARED', 'DECLARED', 'UNDER_INSPECTION', 'RELEASED', 'HELD'] as const;
export type CustomsStatus = (typeof CUSTOMS_STATUS)[number];

export const CONTAINER_STATUS = ['ON_VESSEL', 'DISCHARGED', 'IN_YARD', 'GATED_OUT', 'GATED_IN', 'LOADED', 'ON_RAIL', 'ON_BARGE', 'IN_TRANSIT', 'AT_FACILITY', 'DELIVERED'] as const;
export type ContainerStatus = (typeof CONTAINER_STATUS)[number];

export const DO_STATUS = ['REQUESTED', 'ISSUED', 'REJECTED', 'REVOKED', 'USED'] as const;
export type DoStatus = (typeof DO_STATUS)[number];
export const DO_FLOW: Transitions<DoStatus> = {
  REQUESTED: ['ISSUED', 'REJECTED'],
  ISSUED: ['REVOKED', 'USED'],
  REJECTED: [],
  REVOKED: [],
  USED: [],
};

export const APPOINTMENT_STATUS = ['BOOKED', 'GATED_IN', 'GATED_OUT', 'CANCELLED', 'NO_SHOW'] as const;
export type AppointmentStatus = (typeof APPOINTMENT_STATUS)[number];
export const APPOINTMENT_FLOW: Transitions<AppointmentStatus> = {
  BOOKED: ['GATED_IN', 'CANCELLED', 'NO_SHOW'],
  GATED_IN: ['GATED_OUT'],
  GATED_OUT: [],
  CANCELLED: [],
  NO_SHOW: [],
};

export const SERVICE_STATUS = ['REQUESTED', 'ACCEPTED', 'REJECTED', 'SCHEDULED', 'COMPLETED', 'CANCELLED'] as const;
export type ServiceStatus = (typeof SERVICE_STATUS)[number];
export const SERVICE_FLOW: Transitions<ServiceStatus> = {
  REQUESTED: ['ACCEPTED', 'REJECTED', 'CANCELLED'],
  ACCEPTED: ['SCHEDULED', 'COMPLETED', 'CANCELLED'],
  SCHEDULED: ['COMPLETED', 'CANCELLED'],
  REJECTED: [],
  COMPLETED: [],
  CANCELLED: [],
};

export const BARGE_STATUS = ['PLANNED', 'NOTIFIED', 'ARRIVED', 'WORKING', 'DEPARTED', 'CANCELLED'] as const;
export type BargeStatus = (typeof BARGE_STATUS)[number];
export const BARGE_FLOW: Transitions<BargeStatus> = {
  PLANNED: ['NOTIFIED', 'CANCELLED'],
  NOTIFIED: ['ARRIVED', 'CANCELLED'],
  ARRIVED: ['WORKING', 'DEPARTED'],
  WORKING: ['DEPARTED'],
  DEPARTED: [],
  CANCELLED: [],
};

export const RAIL_STATUS = ['PLANNED', 'ANNOUNCED', 'ARRIVED', 'LOADING', 'DEPARTED', 'CANCELLED'] as const;
export type RailStatus = (typeof RAIL_STATUS)[number];
export const RAIL_FLOW: Transitions<RailStatus> = {
  PLANNED: ['ANNOUNCED', 'CANCELLED'],
  ANNOUNCED: ['ARRIVED', 'CANCELLED'],
  ARRIVED: ['LOADING', 'DEPARTED'],
  LOADING: ['DEPARTED'],
  DEPARTED: [],
  CANCELLED: [],
};

export const INVOICE_STATUS = ['DRAFT', 'ISSUED', 'PAID', 'CANCELLED'] as const;
export type InvoiceStatus = (typeof INVOICE_STATUS)[number];

export const ORG_STATUS = ['PENDING', 'ACTIVE', 'SUSPENDED', 'REJECTED'] as const;
export type OrgStatus = (typeof ORG_STATUS)[number];

export function canTransition<S extends string>(flow: Transitions<S>, from: S, to: S): boolean {
  return (flow[from] ?? []).includes(to);
}

// ---------- Inland facilities: dry ports (ICD), empty depots, CFS ----------
export const FACILITY_TYPES = ['DRY_PORT', 'EMPTY_DEPOT', 'CFS'] as const;
export type FacilityType = (typeof FACILITY_TYPES)[number];

export const TRANSFER_STATUS = ['REQUESTED', 'CUSTOMS_APPROVED', 'REJECTED', 'IN_TRANSIT', 'ARRIVED', 'CANCELLED'] as const;
export type TransferStatus = (typeof TRANSFER_STATUS)[number];
export const TRANSFER_FLOW: Transitions<TransferStatus> = {
  REQUESTED: ['CUSTOMS_APPROVED', 'REJECTED', 'CANCELLED'],
  CUSTOMS_APPROVED: ['IN_TRANSIT', 'CANCELLED'],
  IN_TRANSIT: ['ARRIVED'],
  REJECTED: [],
  ARRIVED: [],
  CANCELLED: [],
};

export const CFS_JOB_STATUS = ['REQUESTED', 'SCHEDULED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'] as const;
export type CfsJobStatus = (typeof CFS_JOB_STATUS)[number];
export const CFS_JOB_FLOW: Transitions<CfsJobStatus> = {
  REQUESTED: ['SCHEDULED', 'IN_PROGRESS', 'CANCELLED'],
  SCHEDULED: ['IN_PROGRESS', 'CANCELLED'],
  IN_PROGRESS: ['COMPLETED'],
  COMPLETED: [],
  CANCELLED: [],
};

export const REPAIR_STATUS = ['ESTIMATED', 'APPROVED', 'REJECTED', 'COMPLETED'] as const;
export type RepairStatus = (typeof REPAIR_STATUS)[number];

/** IICL-style damage codes used in the depot condition survey. */
export const DAMAGE_CODES: Record<string, string> = {
  BT: 'Bent', BR: 'Broken', CU: 'Cut', DT: 'Dent', HO: 'Hole', MS: 'Missing', CO: 'Corroded', DY: 'Dirty', WT: 'Wet / leaking', LO: 'Loose',
};
export const CONTAINER_COMPONENTS = ['Front panel', 'Door', 'Left side panel', 'Right side panel', 'Roof', 'Floor', 'Corner post', 'Corner casting', 'Cross member', 'Rail', 'Locking gear'];
