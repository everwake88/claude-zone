import { tt } from './i18n-core';

// the database answers with a code when something cannot be done; this is what the desk reads
const SAID: Record<string, string> = {
  SLOT_NOT_AVAILABLE: 'That time is not free any more. Pick another.',
  SLOT_TAKEN: 'Someone took that time a moment ago. Pick another.',
  PATIENT_NEEDED: 'Choose the patient, or add a new one.',
  DOCTOR_NEEDED: 'Choose the doctor.',
  WHICH_DOCTOR: 'Choose the doctor.',
  TIME_NEEDED: 'Choose a time.',
  DATE_NEEDED: 'Choose a day.',
  MINUTES_NEEDED: 'Between 5 and 240 minutes.',
  BAD_RANGE: 'Up to 60 days at a time.',
  AGE_NOT_SERVED: 'This service is not for the patient’s age.',
  NOT_FOR_NEW_PATIENTS: 'This time is not for new patients.',
  CONSULT_FIRST: 'This service needs a check-up first.',
  TOO_FAR_AHEAD: 'That is further ahead than bookings open.',
  NOT_ALLOWED: 'Your role cannot do this.'
};
export const said = (code?: string | null, fallback = 'That did not work. Try again.') => tt(code && SAID[code] ? SAID[code] : fallback);

// an RPC that answers {ok:false, error} becomes a thrown, readable error
export function okOrThrow<T extends { ok?: boolean; error?: string }>(r: T | null): T {
  if (!r) throw new Error(tt('That did not work. Try again.'));
  if (r.ok === false) throw new Error(said(r.error));
  return r;
}
