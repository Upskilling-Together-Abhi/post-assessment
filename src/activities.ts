import { ApplicationFailure } from '@temporalio/common';
import { createOnce, readRecord } from './store';
import type { BookingRecord, MessageRecord, Scenario, WaitlistClient } from './types';

export async function readWaitlist(openingId: string): Promise<WaitlistClient[]> {
  const scenario = await readRecord<Scenario>('scenarios', openingId);
  if (!scenario) throw ApplicationFailure.nonRetryable('Simulated sheet not found', 'MissingSheet');
  return scenario.clients;
}
export async function sendOffer(message: MessageRecord): Promise<MessageRecord> {
  const recorded = await createOnce('messages', message.offerId, message);
  if (recorded.openingId !== message.openingId || recorded.clientId !== message.clientId || recorded.deadline !== message.deadline) {
    throw ApplicationFailure.nonRetryable('Offer ID already used for another message', 'MessageConflict');
  }
  return recorded;
}
export async function bookOpening(booking: BookingRecord): Promise<BookingRecord> {
  const recorded = await createOnce('bookings', booking.openingId, booking);
  if (recorded.offerId !== booking.offerId || recorded.clientId !== booking.clientId) {
    throw ApplicationFailure.nonRetryable('Opening already booked', 'BookingConflict');
  }
  return recorded;
}
