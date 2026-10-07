export const DEMO_PRESETS = ['manual', 'match', 'queue', 'saturday', 'exhausted'] as const;
export type DemoPreset = typeof DEMO_PRESETS[number];
export interface DemoRunState { preset: DemoPreset; status: 'running' | 'complete' | 'failed'; error?: string }
export interface WaitlistClient {
  id: string;
  name: string;
  initials: string;
  service: string;
  stylist: string;
  joinedAt: number;
  availableFrom: number;
  availableTo: number;
  durationMinutes: number;
}
export interface MatchedClient extends WaitlistClient {
  eligible: boolean;
  reason: string;
}
export interface Opening {
  id: string;
  startAt: number;
  service: string;
  stylist: string;
  durationMinutes: number;
  responseWindowMs: number;
  simulated: true;
  demoPreset?: DemoPreset;
}
export interface Scenario { opening: Opening; clients: WaitlistClient[] }
export type OfferStatus = 'sending' | 'active' | 'accepting' | 'accepted' | 'declined' | 'expired' | 'delivery_failed' | 'booking_failed';
export interface Offer {
  id: string;
  clientId: string;
  status: OfferStatus;
  sentAt: number;
  expiresAt: number;
  delivered: boolean;
  late: boolean;
}
export interface HistoryEvent { text: string; person: string; at: number }
export interface OpeningState {
  opening: Opening;
  demo?: DemoRunState;
  workflowId: string;
  phase: 'open' | 'loading' | 'offering' | 'booking' | 'booked' | 'exhausted' | 'attention' | 'closed';
  clients: MatchedClient[];
  offers: Offer[];
  events: HistoryEvent[];
}
export interface Reply { offerId: string; clientId: string; response: 'accept' | 'decline' }
export interface ReplyResult { accepted: boolean; code: 'confirmed' | 'declined' | 'expired' | 'invalid_offer' | 'unavailable' | 'booking_failed' }
export interface MessageRecord { openingId: string; offerId: string; clientId: string; deadline: number }
export interface BookingRecord { openingId: string; offerId: string; clientId: string }
export const workflowIdFor = (id: string) => `juniper-opening-${id}`;
export const TASK_QUEUE = 'juniper-waitlist';
