import { allHandlersFinished, condition, defineQuery, defineUpdate, proxyActivities, setHandler, sleep, startChild } from '@temporalio/workflow';
import type * as activities from './activities';
import type * as demoActivities from './demo-activities';
import type { DemoRunState, Offer } from './types';
import { matchClients } from './matching';
import { workflowIdFor, type Opening, type OpeningState, type Reply, type ReplyResult } from './types';

export const getOpening = defineQuery<OpeningState>('getOpening');
export const replyToOffer = defineUpdate<ReplyResult, [Reply]>('replyToOffer');
const { readWaitlist, sendOffer, bookOpening } = proxyActivities<typeof activities>({
  startToCloseTimeout: '10 seconds',
  scheduleToCloseTimeout: '30 seconds',
  retry: { initialInterval: '1 second', maximumInterval: '5 seconds', maximumAttempts: 3 },
});

export async function openingWorkflow(opening: Opening): Promise<OpeningState> {
  const state: OpeningState = { opening, workflowId: workflowIdFor(opening.id), phase: 'loading', clients: [], offers: [], events: [] };
  const log = (text: string, person = '') => state.events.unshift({ text, person, at: Date.now() });
  const clientName = (id: string) => state.clients.find(client => client.id === id)?.name ?? id;
  setHandler(getOpening, () => state);
  setHandler(replyToOffer, async (reply): Promise<ReplyResult> => {
    if (!reply || !['accept', 'decline'].includes(reply.response)) return { accepted: false, code: 'invalid_offer' };
    const offer = state.offers.find(item => item.id === reply.offerId && item.clientId === reply.clientId);
    if (!offer) return { accepted: false, code: 'invalid_offer' };
    // Retries and competing clicks converge on the existing claim.
    if (offer.status === 'accepting') await condition(() => offer.status !== 'accepting');
    if (offer.status === 'accepted') return { accepted: reply.response === 'accept', code: reply.response === 'accept' ? 'confirmed' : 'unavailable' };
    if (offer.status === 'declined') return { accepted: reply.response === 'decline', code: reply.response === 'decline' ? 'declined' : 'unavailable' };
    if (offer.status === 'active' && (Date.now() >= offer.expiresAt || Date.now() >= opening.startAt)) {
      offer.status = 'expired';
      log('Offer expired', clientName(offer.clientId));
    }
    if (offer.status === 'expired') {
      if (!offer.late) { offer.late = true; log(`Late ${reply.response === 'accept' ? 'acceptance' : 'decline'} rejected`, clientName(offer.clientId)); }
      return { accepted: false, code: 'expired' };
    }
    if (offer.status !== 'active' || state.phase !== 'offering') return { accepted: false, code: 'unavailable' };
    if (reply.response === 'decline') {
      offer.status = 'declined'; log('Offer declined', clientName(offer.clientId));
      return { accepted: true, code: 'declined' };
    }
    // Reserve synchronously before the first await: two Updates cannot claim
    // different clients while the booking Activity is in flight.
    offer.status = 'accepting'; state.phase = 'booking';
    log('Acceptance received', clientName(offer.clientId));
    try {
      await bookOpening({ openingId: opening.id, offerId: offer.id, clientId: offer.clientId });
      offer.status = 'accepted'; state.phase = 'booked';
      log('Appointment confirmed', clientName(offer.clientId));
      return { accepted: true, code: 'confirmed' };
    } catch {
      offer.status = 'booking_failed'; state.phase = 'attention';
      log('Booking failed · staff attention required', clientName(offer.clientId));
      return { accepted: false, code: 'booking_failed' };
    }
  });

  log('Opening received', `${opening.service} · ${opening.stylist}`);
  if (opening.startAt <= Date.now() || opening.startAt - Date.now() > 48 * 60 * 60_000 || !Number.isFinite(opening.responseWindowMs) || opening.responseWindowMs <= 0) {
    state.phase = 'attention'; log('Opening outside supported window or missing response policy');
    return state;
  }
  try { state.clients = matchClients(opening, await readWaitlist(opening.id)); }
  catch { state.phase = 'attention'; log('Waitlist unavailable · staff attention required'); return state; }
  log('Waitlist matched', `${state.clients.filter(client => client.eligible).length} eligible clients`);
  for (const client of state.clients.filter(client => client.eligible)) {
    if (Date.now() >= opening.startAt) break;
    const now = Date.now();
    const offer = { id: `${opening.id}-offer-${state.offers.length + 1}`, clientId: client.id, status: 'sending' as OpeningState['offers'][number]['status'], sentAt: now, expiresAt: Math.min(now + opening.responseWindowMs, opening.startAt), delivered: false, late: false };
    state.offers.push(offer); state.phase = 'offering';
    try {
      await sendOffer({ openingId: opening.id, offerId: offer.id, clientId: client.id, deadline: offer.expiresAt });
      offer.delivered = true; offer.status = 'active'; log('Offer sent', client.name);
    } catch {
      offer.status = 'delivery_failed'; log('Message delivery failed', client.name); continue;
    }
    // Temporal records this timer. No browser timer or API process owns it.
    const remaining = offer.expiresAt - Date.now();
    if (remaining > 0) await condition(() => offer.status !== 'active', remaining);
    // Handlers can mutate the offer while this coroutine is suspended.
    const currentStatus = () => offer.status;
    if (currentStatus() === 'active') { offer.status = 'expired'; log('Offer expired', client.name); }
    if (currentStatus() === 'accepting') await condition(() => offer.status !== 'accepting');
    if (currentStatus() === 'accepted' || currentStatus() === 'booking_failed') break;
  }
  if (state.phase === 'offering' || state.phase === 'loading') {
    state.phase = 'exhausted'; log(Date.now() >= opening.startAt ? 'Appointment time reached' : 'Waitlist exhausted');
  }
  // Keep replies auditable after booking/exhaustion until the appointment ends.
  // The business process is finished; this bounded inbox still rejects late links.
  const auditRemaining = opening.startAt + opening.durationMinutes * 60_000 - Date.now();
  if (auditRemaining > 0) await condition(() => false, auditRemaining);
  await condition(allHandlersFinished);
  return state;
}


export const getDemoRun = defineQuery<DemoRunState>('getDemoRun');
const demo = proxyActivities<typeof demoActivities>({
  startToCloseTimeout: '15 seconds',
  scheduleToCloseTimeout: '45 seconds',
  retry: { initialInterval: '1 second', maximumInterval: '5 seconds', maximumAttempts: 4 },
});

export async function scenarioWorkflow(opening: Opening): Promise<DemoRunState> {
  const run: DemoRunState = { preset: opening.demoPreset ?? 'manual', status: 'running' };
  setHandler(getDemoRun, () => run);
  const openingId = opening.id;
  async function waitForOffer(clientId: string): Promise<Offer> {
    const limit = Date.now() + 120_000;
    while (Date.now() < limit) {
      const state = await demo.readDemoOpening(openingId);
      const offer = state.offers.find(item => item.clientId === clientId && item.status === 'active');
      if (offer) return offer;
      if (['booked', 'attention', 'exhausted'].includes(state.phase)) throw new Error('Scenario was interrupted');
      await sleep('500 milliseconds');
    }
    throw new Error('Scenario timed out');
  }
  async function reply(offer: Offer, response: 'accept' | 'decline') {
    return demo.sendDemoReply(openingId, { offerId: offer.id, clientId: offer.clientId, response });
  }
  try {
    await startChild(openingWorkflow, {
      workflowId: workflowIdFor(openingId), args: [opening],
      workflowIdReusePolicy: 'REJECT_DUPLICATE', parentClosePolicy: 'ABANDON',
    });
    const maya = await waitForOffer('maya');
    if (run.preset === 'match') {
      await sleep('3 seconds');
      if ((await reply(maya, 'accept')).code !== 'confirmed') throw new Error('Maya was not confirmed');
    } else if (run.preset === 'saturday') {
      const alex = await waitForOffer('alex');
      await sleep('2 seconds');
      // Two real Updates race: Maya's stale link and Alex's current offer.
      const [late, valid] = await Promise.all([reply(maya, 'accept'), reply(alex, 'accept')]);
      if (late.code !== 'expired' || valid.code !== 'confirmed') throw new Error('Unexpected Saturday result');
    } else {
      await sleep('2 seconds');
      await reply(maya, 'decline');
      // Alex deliberately does nothing. Only the opening Workflow's timer advances.
      const jordan = await waitForOffer('jordan');
      await sleep('2 seconds');
      if (run.preset === 'queue') {
        if ((await reply(jordan, 'accept')).code !== 'confirmed') throw new Error('Jordan was not confirmed');
      } else {
        await reply(jordan, 'decline');
        const limit = Date.now() + 120_000;
        while ((await demo.readDemoOpening(openingId)).phase !== 'exhausted') {
          if (Date.now() >= limit) throw new Error('Waitlist did not exhaust');
          await sleep('500 milliseconds');
        }
      }
    }
    run.status = 'complete';
  } catch {
    run.status = 'failed';
    run.error = 'Scenario interrupted. Run a new demo.';
  }
  return run;
}
