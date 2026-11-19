import auth from './auth.js';
import admin from './admin.js';
import common from './common.js';
import vesselCalls from './vessel-calls.js';
import cargo from './cargo.js';
import delivery from './delivery.js';
import operations from './operations.js';
import finance from './finance.js';
import edi from './edi.js';
import analytics from './analytics.js';
import inland from './inland.js';

// One Fastify plugin per PRD bounded context.
export const modules = [auth, admin, common, vesselCalls, cargo, delivery, operations, finance, edi, analytics, inland];
