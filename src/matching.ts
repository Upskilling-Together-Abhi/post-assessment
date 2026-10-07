import type { MatchedClient, Opening, WaitlistClient } from './types';

export function matchClients(opening: Opening, clients: WaitlistClient[]): MatchedClient[] {
  const endAt = opening.startAt + opening.durationMinutes * 60_000;
  return clients.map(client => {
    const reason = client.service !== opening.service ? 'Service mismatch'
      : client.stylist !== 'Any stylist' && client.stylist !== opening.stylist ? 'Stylist mismatch'
      : client.durationMinutes > opening.durationMinutes ? 'Duration mismatch'
      : client.availableFrom > opening.startAt || client.availableTo < endAt ? 'Time mismatch'
      : '';
    return { ...client, eligible: !reason, reason };
  }).sort((a, b) => a.joinedAt - b.joinedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
