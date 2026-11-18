import { tenantDoc } from './tenantDoc';

/** When the office's samples and test data were last cleared. Anything older that the
 *  database still holds (inbox, outputs, approvals, plans, activity) is not loaded back. */
export const officeClearedDoc = tenantDoc<{ at: number }>('office-cleared', () => ({ at: 0 }));
