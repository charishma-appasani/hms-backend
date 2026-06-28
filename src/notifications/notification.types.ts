/** Who to notify — resolved from the patient's app_user (phone is primary, email optional). */
export interface NotificationRecipient {
  name: string;
  email?: string | null;
  phone?: string | null;
}

/** Minimal appointment reference shown in a notification. */
export interface AppointmentRef {
  sessionDate: string; // YYYY-MM-DD
  tokenNumber: number | null;
}

/** The events patients are notified about (schedule changes they didn't initiate). */
export type NotificationEvent =
  | {
      kind: 'appointment_rescheduled';
      reason?: string;
      from: AppointmentRef;
      to: AppointmentRef;
    }
  | {
      kind: 'appointment_cancelled';
      reason?: string;
      appointment: AppointmentRef;
    };

export interface NotificationMessage {
  subject: string;
  body: string;
}
