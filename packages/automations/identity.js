import { stableHash } from '../shared/utils.js';
export const automationEnrollmentIdFor=(organizationId,sequenceId,contactId)=>stableHash('automation-enrollment-v1',organizationId,sequenceId,contactId);
export const automationStepRunIdFor=(enrollmentId,index)=>stableHash('automation-step-run-v1',enrollmentId,index);
